// @effect-diagnostics nodeBuiltinImport:off -- stable digests bind evidence and identities to exact durable state.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  CommandId,
  MessageId,
  isOrchestrationV2WorkActive,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { Mission } from "../../../../packages/contracts/src/mission.ts";
import {
  emptyMissionExecution,
  missionManagerReservations,
} from "../../../../packages/contracts/src/missionExecution.ts";
import {
  managerReservationState,
  type MissionManagerReservation,
} from "../../../../packages/contracts/src/missionManagerTransfer.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import {
  MissionManagerLifecycleAuthority,
  MissionManagerLifecycleFactsPort,
  MissionManagerLifecycleStoreError,
  type ManagerLifecycleFacts,
  type ManagerLifecycleStep,
} from "./MissionManagerLifecycleStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * Runtime adapter for the P3 manager rotation (source-only until the root
 * composes it). It is the code that actually touches threads, provider
 * sessions and MCP credentials for the accepted lifecycle protocol:
 *
 * - `launchStandby` creates the reserved successor through `ThreadLaunch`'s
 *   standby mode: a bare thread record under the reservation's canonical
 *   successor id. Nothing runs in it before the owner switch.
 * - `readLifecycleFacts` is the private facts producer the lifecycle store
 *   requires. It reports only what durable state and live services show, and
 *   leaves a section absent (a finite hold) when no real source exists.
 * - `cleanupIncumbent` retires the incumbent's OWN provider sessions and the
 *   MCP credentials bound to its thread after routing is confirmed, and
 *   nothing else.
 * - `wakeCurrentRole` delivers to whoever the canonical mission names for the
 *   role right now, never to a remembered thread.
 *
 * Facts it does not invent:
 * - Integration, GUI ownership, shared writes, any process fence and
 *   completion-routing readiness have no runtime source in this repository.
 *   They come only from the optional `MissionManagerBoundaryFacts` port; when
 *   it is absent the quiesce and transfer steps hold as unknown. A prompt
 *   token is never reported as a fence.
 * - The successor's routing confirmation is the successor's own acknowledgement
 *   in its thread (see `MANAGER_ACK_PREFIX`), read back from durable messages.
 *   The adapter never confirms routing on the model's behalf.
 *
 * Cleanup is deliberately narrow. For each provider session the incumbent
 * owns, a session that cannot be shared is released (its process stops and the
 * projection records it stopped); one that other threads may share is only
 * detached from the incumbent and the detach recorded. The incumbent's MCP
 * credentials are then revoked. It never calls a global stop, logout or host
 * shutdown, and it never touches a worker thread's sessions or resources. An
 * active incumbent run, an active provider-native subagent that lives in the
 * session, or a session set it cannot reconcile holds the cleanup instead.
 */
export class MissionManagerRuntimeError extends Schema.TaggedError<MissionManagerRuntimeError>()(
  "MissionManagerRuntimeError",
  {
    operation: Schema.Literals(["launch-standby", "observe", "cleanup", "wake"]),
    category: Schema.Literals(["scope_denied", "request_conflict", "persistence"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Mission manager ${this.operation} failed (${this.category}).`;
  }
}

const isRuntimeError = Schema.is(MissionManagerRuntimeError);

/** A finite, non-persisted hold: nothing was changed and a retry may succeed. */
type ManagerRuntimeHoldCode =
  | "mission_inactive"
  | "not_launchable"
  | "owner_changed"
  | "no_manager"
  | "not_retirable"
  | "incumbent_active"
  | "child_dependencies"
  | "cleanup_incomplete";

interface ManagerRuntimeHold {
  readonly kind: "hold";
  readonly code: ManagerRuntimeHoldCode;
}

interface ManagerRoleRequest {
  readonly missionId: string;
  readonly role: "delivery" | "retro";
}

interface ManagerReservationRequest extends ManagerRoleRequest {
  readonly reservationId: string;
}

type StandbyLaunchOutcome =
  | {
      readonly kind: "standby";
      readonly threadId: string;
      readonly commandId: string;
      /** True when a prior launch already recorded this thread. */
      readonly resumed: boolean;
    }
  | ManagerRuntimeHold;

type IncumbentCleanupOutcome =
  | {
      readonly kind: "released";
      /** Provider sessions the incumbent no longer owns, by id. */
      readonly sessionIds: ReadonlyArray<string>;
    }
  | ManagerRuntimeHold;

export interface WakeRequest extends ManagerRoleRequest {
  /** Stable key: the same key at the same owner epoch is one delivery. */
  readonly wakeKey: string;
  readonly instruction: string;
  /** Activation wake: asks the new owner to acknowledge this reservation's epoch. */
  readonly reservationId?: string;
  /** The owner the caller last read; a different current owner is a hold, not a wake. */
  readonly expectedOwner?: { readonly threadId: string; readonly epoch: number };
}

type WakeOutcome =
  | {
      readonly kind: "sent";
      readonly threadId: string;
      readonly epoch: number;
      readonly revision: number;
      readonly commandId: string;
    }
  | ManagerRuntimeHold;

type BoundaryTriState = "none" | "present" | "unknown";

/**
 * Facts the runtime cannot observe itself. A producer reports `null` / `unknown`
 * rather than guessing; a confirmed fence is only a process or write fence.
 */
export interface ManagerQuiesceBoundary {
  readonly integrationRunning: boolean | null;
  readonly guiOwned: boolean | null;
  readonly unmanagedShellWrites: BoundaryTriState;
  readonly sharedWrites: BoundaryTriState;
  readonly fence: {
    readonly kind: "confirmed_process_fence" | "confirmed_write_fence";
    readonly digest: string;
  } | null;
}

export class MissionManagerBoundaryFacts extends Context.Service<
  MissionManagerBoundaryFacts,
  {
    readonly quiesceBoundary: (
      request: ManagerRoleRequest & {
        readonly incumbentThreadId: string;
        readonly incumbentEpoch: number;
      },
    ) => Effect.Effect<ManagerQuiesceBoundary | null>;
    readonly completionRoutingReady: (request: ManagerRoleRequest) => Effect.Effect<boolean | null>;
  }
>()("t3/orchestration-v2/MissionManagerRuntimeAdapter/MissionManagerBoundaryFacts") {}

export class MissionManagerRuntimeAdapter extends Context.Service<
  MissionManagerRuntimeAdapter,
  {
    readonly launchStandby: (
      request: ManagerReservationRequest,
    ) => Effect.Effect<StandbyLaunchOutcome, MissionManagerRuntimeError>;
    readonly readLifecycleFacts: (
      request: ManagerReservationRequest & { readonly step: ManagerLifecycleStep },
    ) => Effect.Effect<ManagerLifecycleFacts, MissionManagerRuntimeError>;
    readonly cleanupIncumbent: (
      request: ManagerReservationRequest,
    ) => Effect.Effect<IncumbentCleanupOutcome, MissionManagerRuntimeError>;
    readonly wakeCurrentRole: (
      request: WakeRequest,
    ) => Effect.Effect<WakeOutcome, MissionManagerRuntimeError>;
    /** Producer revision token facts are stamped with; changes after any adapter action. */
    readonly currentFence: () => string;
  }
>()("t3/orchestration-v2/MissionManagerRuntimeAdapter") {}

/** Prefix of the single line the new owner writes to acknowledge its epoch. */
export const MANAGER_ACK_PREFIX = "T3-MANAGER-ACK";

/** The acknowledgement line the new owner must reply with, for one reservation epoch. */
export const managerAckLine = (input: {
  readonly reservationId: string;
  readonly role: "delivery" | "retro";
  readonly epoch: number;
  readonly revision: number;
}): string =>
  `${MANAGER_ACK_PREFIX} reservation=${input.reservationId} role=${input.role} epoch=${input.epoch} revision=${input.revision}`;

const ACK_PATTERN = new RegExp(
  `^${MANAGER_ACK_PREFIX} reservation=(\\S+) role=(delivery|retro) epoch=(\\d+) revision=(\\d+)\\s*$`,
  "m",
);

/** Most owned resources one cleanup receipt can name (the lifecycle evidence bound). */
const MAX_OWNED_RESOURCES = 16;
const MAX_ID_LENGTH = 512;

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
const LIVE_SESSION_STATUSES: ReadonlySet<string> = new Set(["starting", "running", "waiting"]);

const sha256 = (value: unknown): string =>
  NodeCrypto.createHash("sha256").update(stableStringify(value), "utf8").digest("hex");

const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));

type StandbyEvidence = NonNullable<ManagerLifecycleFacts["standby"]>;
type QuiesceEvidence = NonNullable<ManagerLifecycleFacts["quiesce"]>;
type RoutingEvidence = NonNullable<ManagerLifecycleFacts["routing"]>;
type CleanupEvidence = NonNullable<ManagerLifecycleFacts["cleanup"]>;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authoritySvc = yield* MissionManagerLifecycleAuthority;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const mcpRegistry = yield* McpSessionRegistry.McpSessionRegistry;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const boundary = yield* Effect.serviceOption(MissionManagerBoundaryFacts);
  // Actions are serialized in this process; durable receipts and the lifecycle
  // store's revision CAS are what keep a second process honest.
  const actions = yield* Semaphore.make(1);

  // Snapshot the private authority once; keep only the pure currency check.
  const authority = Object.freeze({
    teamId: authoritySvc.teamId,
    environmentId: authoritySvc.environmentId,
    role: authoritySvc.role,
  });
  const authorityIsCurrent = (): boolean => {
    try {
      return authoritySvc.isCurrent() === true;
    } catch {
      return false;
    }
  };

  // Facts are stamped with this token. It advances after any action that can
  // change what a producer would report, so facts read before it are stale. A
  // plain counter is deliberate: the lifecycle store's currency check is
  // synchronous and may not perform I/O.
  const producerId = NodeCrypto.randomUUID();
  let generation = 0;
  const currentFence = (): string => `${producerId}#${generation}`;
  const advanceFence = Effect.sync(() => {
    generation += 1;
  });

  const fail =
    (operation: MissionManagerRuntimeError["operation"]) =>
    (category: MissionManagerRuntimeError["category"], cause?: unknown) =>
      new MissionManagerRuntimeError({
        operation,
        category,
        ...(cause === undefined ? {} : { cause }),
      });
  const toError =
    (operation: MissionManagerRuntimeError["operation"]) =>
    (cause: unknown): MissionManagerRuntimeError =>
      isRuntimeError(cause) ? cause : fail(operation)("persistence", cause);

  const hold = (code: ManagerRuntimeHoldCode): ManagerRuntimeHold => ({ kind: "hold", code });

  /** The canonical mission, the reservation and the role's current owner, freshly read. */
  const locate = (
    operation: MissionManagerRuntimeError["operation"],
    request: ManagerRoleRequest & { readonly reservationId?: string },
  ) =>
    Effect.gen(function* () {
      if (!authorityIsCurrent() || request.role !== authority.role) {
        return yield* fail(operation)("scope_denied");
      }
      const rows = yield* sql<{ revision: number; snapshot_json: string }>`
        SELECT revision, snapshot_json FROM projection_missions
        WHERE mission_id = ${request.missionId}
          AND team_id = ${authority.teamId}
          AND authority_environment_id = ${authority.environmentId}
      `;
      if (rows[0] === undefined) return yield* fail(operation)("scope_denied");
      const canonical = yield* decodeMission(rows[0].snapshot_json);
      if (rows[0].revision !== canonical.revision) return yield* fail(operation)("persistence");
      const assignment =
        request.role === "delivery" ? canonical.managers.delivery : canonical.managers.retro;
      const reservations = missionManagerReservations(
        canonical.execution ?? emptyMissionExecution(),
      );
      const reservation =
        request.reservationId === undefined
          ? undefined
          : reservations.find((entry) => entry.reservationId === request.reservationId);
      if (
        request.reservationId !== undefined &&
        (reservation === undefined || reservation.role !== request.role)
      ) {
        return yield* fail(operation)("scope_denied");
      }
      return { canonical, assignment, reservation };
    }).pipe(Effect.mapError(toError(operation)));

  /**
   * A read that cannot be completed is unknown evidence, never an inferred
   * fact. Interruption is not swallowed.
   */
  const orUnknown = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) => {
    const unavailable = (cause: unknown) =>
      Effect.logWarning("mission-manager-runtime.observation-unavailable", { label, cause }).pipe(
        Effect.as(null),
      );
    return effect.pipe(
      Effect.map((value): A | null => value),
      Effect.catch(unavailable),
      Effect.catchDefect(unavailable),
    );
  };

  const standbyCommandId = (reservationId: string) =>
    CommandId.make(`manager-standby:${reservationId}`);

  // ---------------------------------------------------------------- standby

  const launchStandby: MissionManagerRuntimeAdapter["Service"]["launchStandby"] = (request) =>
    actions.withPermits(1)(
      Effect.gen(function* () {
        const { canonical, assignment, reservation } = yield* locate("launch-standby", request);
        if (reservation === undefined) return yield* fail("launch-standby")("scope_denied");
        if (canonical.status !== "active") return hold("mission_inactive");
        const state = managerReservationState(reservation);
        // The owner switch is final for the launch: later states only replay reads.
        if (state !== "reserved" && state !== "standby_ready" && state !== "quiesced") {
          return hold("not_launchable");
        }
        if (
          assignment?.threadId !== reservation.currentThreadId ||
          assignment.epoch !== reservation.currentEpoch
        ) {
          return hold("owner_changed");
        }
        const incumbent = yield* threads
          .getThreadRecords(ThreadId.make(reservation.currentThreadId), [])
          .pipe(Effect.mapError(toError("launch-standby")));
        const thread = incumbent.thread;
        const commandId = standbyCommandId(reservation.reservationId);
        const launched = yield* launches
          .launch({
            commandId,
            threadId: ThreadId.make(reservation.successorThreadId),
            projectId: thread.projectId,
            title: `${thread.title.replace(/ · \d{4}-\d{2}-\d{2}(?: #\d+)?$/, "")} · ${reservation.localDate}${
              reservation.ordinal > 1 ? ` #${reservation.ordinal}` : ""
            }`,
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            workspaceStrategy:
              thread.worktreePath === null
                ? { type: "root", ...(thread.branch === null ? {} : { branch: thread.branch }) }
                : {
                    type: "existing_worktree",
                    worktreePath: thread.worktreePath,
                    ...(thread.branch === null ? {} : { branch: thread.branch }),
                  },
            createdBy: "system",
            creationSource: "server",
            standby: true,
          })
          .pipe(
            Effect.mapError((cause) =>
              fail("launch-standby")(
                cause.operation === "verify-standby" ? "request_conflict" : "persistence",
                cause,
              ),
            ),
          );
        yield* advanceFence;
        return {
          kind: "standby",
          threadId: launched.threadId,
          commandId,
          resumed: launched.resumed,
        } satisfies StandbyLaunchOutcome;
      }).pipe(Effect.mapError(toError("launch-standby"))),
    );

  /**
   * Structural readiness of the reserved successor: the thread exists under the
   * canonical id from this reservation's own launch receipt and is still inert
   * (no run, message or provider session, so nothing can dispatch or hold a GUI
   * lease). The digest binds the receipt that created it. The successor's own
   * reread of the mission is a later, model-side step (see routing).
   */
  const observeStandby = (
    reservation: MissionManagerReservation,
    canonicalRevision: number,
  ): Effect.Effect<StandbyEvidence | null> =>
    orUnknown(
      "standby",
      Effect.gen(function* () {
        const receipt = yield* receipts.getByCommandId(standbyCommandId(reservation.reservationId));
        if (
          Option.isNone(receipt) ||
          receipt.value.status !== "accepted" ||
          receipt.value.commandType !== "thread.create" ||
          receipt.value.threadId !== reservation.successorThreadId
        ) {
          return null;
        }
        const records = yield* threads.getThreadRecords(
          ThreadId.make(reservation.successorThreadId),
          ["runs", "providerSessions", "subagents"],
        );
        const inert =
          records.thread.archivedAt === null &&
          records.thread.deletedAt === null &&
          records.runs.length === 0 &&
          records.providerSessions.length === 0 &&
          records.subagents.length === 0 &&
          (yield* threads.getMessageCount(ThreadId.make(reservation.successorThreadId))) === 0;
        return {
          reservationId: reservation.reservationId,
          role: reservation.role,
          successorThreadId: reservation.successorThreadId,
          handoffSha256: reservation.artifactSha256,
          epoch: reservation.currentEpoch,
          observedRevision: reservation.observedRevision,
          reconciledRevision: canonicalRevision,
          // An inert thread cannot dispatch; a thread that already worked is
          // reported as having dispatched so the lifecycle store denies it.
          dispatchEnabled: !inert,
          guiLeaseHeld: !inert,
          ackDigest: sha256({
            kind: "manager-standby-v1",
            reservationId: reservation.reservationId,
            role: reservation.role,
            successorThreadId: reservation.successorThreadId,
            handoffSha256: reservation.artifactSha256,
            epoch: reservation.currentEpoch,
            observedRevision: reservation.observedRevision,
            createSequence: receipt.value.resultSequence,
          }),
        } satisfies StandbyEvidence;
      }),
    );

  // --------------------------------------------------------------- quiesce

  const observeQuiesce = (
    request: ManagerRoleRequest,
    reservation: MissionManagerReservation,
    incumbentEpoch: number,
  ): Effect.Effect<QuiesceEvidence | null> =>
    orUnknown(
      "quiesce",
      Effect.gen(function* () {
        // Integration, GUI and shared writes have no runtime source here.
        if (Option.isNone(boundary)) return null;
        const external = yield* boundary.value
          .quiesceBoundary({
            ...request,
            incumbentThreadId: reservation.currentThreadId,
            incumbentEpoch,
          })
          .pipe(Effect.catchDefect(() => Effect.succeed(null)));
        if (
          external === null ||
          external.integrationRunning === null ||
          external.guiOwned === null
        ) {
          return null;
        }
        const records = yield* threads.getThreadRecords(
          ThreadId.make(reservation.currentThreadId),
          ["runs", "providerSessions", "providerThreads", "providerTurns"],
        );
        const coordinatorTurnActive =
          records.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)) ||
          records.providerTurns.some(
            (turn) => turn.status === "running" || turn.status === "pending",
          ) ||
          records.providerSessions.some((session) => LIVE_SESSION_STATUSES.has(session.status));
        // Background work in a live provider runtime can write after the turn
        // ends. A runtime that cannot say is unknown, not idle. In a session
        // shared with other threads only the incumbent's own provider threads
        // count when the runtime can tell them apart; otherwise the whole
        // session does, which can only over-hold.
        const background = { present: false, unknown: false };
        const note = (pending: boolean | null) => {
          if (pending !== false) background.present = true;
        };
        for (const session of records.providerSessions) {
          if (session.status === "stopped" || session.status === "error") continue;
          const live = yield* sessions.get(session.id);
          if (Option.isNone(live)) continue;
          const runtime = live.value;
          const own = records.providerThreads.filter(
            (providerThread) => providerThread.providerSessionId === session.id,
          );
          if (runtime.hasPendingBackgroundWorkForThread !== undefined) {
            for (const providerThread of own) {
              note(
                yield* runtime
                  .hasPendingBackgroundWorkForThread(providerThread)
                  .pipe(Effect.catchDefect(() => Effect.succeed(null))),
              );
            }
          } else if (runtime.hasPendingBackgroundWork !== undefined) {
            note(
              yield* runtime.hasPendingBackgroundWork.pipe(
                Effect.catchDefect(() => Effect.succeed(null)),
              ),
            );
          } else {
            background.unknown = true;
          }
        }
        return {
          incumbentThreadId: reservation.currentThreadId,
          incumbentEpoch,
          coordinatorTurnActive,
          integrationRunning: external.integrationRunning,
          guiOwned: external.guiOwned,
          unmanagedShellWrites: background.present
            ? "present"
            : background.unknown
              ? "unknown"
              : external.unmanagedShellWrites,
          sharedWrites: external.sharedWrites,
          fence: external.fence,
        } satisfies QuiesceEvidence;
      }),
    );

  // --------------------------------------------------------------- routing

  /**
   * The new owner's own acknowledgement, read from its durable assistant
   * messages after the switch. Anything else (no message, wrong reservation,
   * wrong epoch, written before the switch) is unknown.
   */
  const observeRouting = (
    reservation: MissionManagerReservation,
  ): Effect.Effect<RoutingEvidence | null> =>
    orUnknown(
      "routing",
      Effect.gen(function* () {
        const transfer = reservation.lifecycle?.transfer;
        if (transfer === undefined) return null;
        const successor = ThreadId.make(reservation.successorThreadId);
        const records = yield* threads.getThreadRecords(successor, ["messages"], {
          messageRoles: ["assistant"],
        });
        const switchedAt = DateTime.toEpochMillis(DateTime.makeUnsafe(transfer.confirmedAt));
        let found: { digest: string; revision: number } | null = null;
        for (const message of records.messages) {
          if (message.role !== "assistant" || message.streaming) continue;
          if (DateTime.toEpochMillis(message.createdAt) < switchedAt) continue;
          const match = ACK_PATTERN.exec(message.text);
          if (match === null) continue;
          if (
            match[1] !== reservation.reservationId ||
            match[2] !== reservation.role ||
            Number(match[3]) !== transfer.newEpoch
          ) {
            continue;
          }
          // Replies carry no reliable order, so the most recent reread is the
          // highest revision the owner attested.
          const revision = Number(match[4]);
          if (found === null || revision >= found.revision) {
            found = { digest: sha256({ messageId: message.id, text: message.text }), revision };
          }
        }
        if (found === null) return null;
        return {
          role: reservation.role,
          managerThreadId: reservation.successorThreadId,
          epoch: transfer.newEpoch,
          confirmed: true,
          confirmationDigest: found.digest,
          reconciledRevision: found.revision,
        } satisfies RoutingEvidence;
      }),
    );

  // --------------------------------------------------------------- cleanup

  const mcpResourceId = (threadId: string) => `mcp-credentials:${threadId}`;
  const sessionResourceId = (sessionId: string) => `provider-session:${sessionId}`;

  /**
   * What the incumbent still owns and what depends on it, from durable
   * projection plus the live session manager. Pure observation.
   */
  const inspectIncumbent = (
    incumbentThreadId: string,
    /** Sessions already known to be the incumbent's, e.g. from before a durable detach. */
    knownSessionIds: ReadonlyArray<string> = [],
  ) =>
    Effect.gen(function* () {
      const records = yield* threads.getThreadRecords(ThreadId.make(incumbentThreadId), [
        "runs",
        "providerSessions",
        "providerThreads",
        "subagents",
      ]);
      const sessionIds = [
        ...new Set([
          ...knownSessionIds,
          ...records.providerSessions.map((session) => String(session.id)),
          ...records.providerThreads.flatMap((providerThread) =>
            providerThread.providerSessionId === null
              ? []
              : [String(providerThread.providerSessionId)],
          ),
        ]),
      ].sort();
      const owned: Array<{
        readonly id: string;
        readonly recorded: boolean;
        readonly released: boolean;
        /** Whether other threads may share the live process; unknown when none is live. */
        readonly shared: boolean | null;
      }> = [];
      for (const id of sessionIds) {
        const recorded = records.providerSessions.some((session) => session.id === id);
        const live = yield* sessions.get(ProviderSessionId.make(id));
        const shared = Option.isSome(live)
          ? live.value.providerSession.capabilities.sessions
              .supportsMultipleProviderThreadsPerSession
          : null;
        // No live runtime means no provider process holds it. A runtime that
        // other threads share stays up, so the incumbent's detach is proven by
        // the durable record instead.
        const released = Option.isNone(live) || (shared === true && !recorded);
        owned.push({ id, recorded, released, shared });
      }
      const allReleased = owned.every((entry) => entry.released);
      const blockingNativeChildren = records.subagents.filter(
        (child) => child.origin === "provider_native" && isOrchestrationV2WorkActive(child.status),
      );
      return {
        records,
        owned,
        allReleased,
        activeRun: records.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)),
        // A native subagent lives inside its session; stopping the session
        // would kill it. Once the session is gone, its stale status blocks nothing.
        childDependencies:
          !allReleased && blockingNativeChildren.length > 0
            ? ("blocking" as const)
            : ("none" as const),
        mcpReleased:
          McpProviderSession.readMcpProviderSession(ThreadId.make(incumbentThreadId)) === undefined,
      };
    });

  const observeCleanup = (
    reservation: MissionManagerReservation,
  ): Effect.Effect<CleanupEvidence | null> =>
    orUnknown(
      "cleanup",
      Effect.gen(function* () {
        const state = managerReservationState(reservation);
        if (state !== "routing_confirmed" && state !== "retired") return null;
        const incumbent = reservation.currentThreadId;
        const inspected = yield* inspectIncumbent(incumbent);
        // A manager thread that never recorded a provider session leaves no
        // receipt to reconcile; that is unknown, not "nothing to release".
        if (inspected.owned.length === 0 || inspected.owned.length + 1 > MAX_OWNED_RESOURCES) {
          return null;
        }
        const expectedIds = [
          ...inspected.owned.map((entry) => sessionResourceId(entry.id)),
          mcpResourceId(incumbent),
        ];
        if (expectedIds.some((id) => id.length > MAX_ID_LENGTH)) return null;
        const releasedIds = [
          ...inspected.owned
            .filter((entry) => entry.released)
            .map((entry) => sessionResourceId(entry.id)),
          ...(inspected.mcpReleased ? [mcpResourceId(incumbent)] : []),
        ];
        // The credentials are issued per thread and revoked with the sessions
        // that served it, so both receipts name the same session set.
        const sessionDigest = sha256({
          kind: "incumbent-provider-sessions-v1",
          threadId: incumbent,
          sessionIds: inspected.owned.map((entry) => entry.id),
        });
        return {
          incumbentThreadId: incumbent,
          providerSession: {
            sessionDigest,
            ownerThreadId: incumbent,
            released: inspected.allReleased,
          },
          mcp: { ownerSessionDigest: sessionDigest, released: inspected.mcpReleased },
          ownedResources: { expectedIds, releasedIds },
          childDependencies: inspected.childDependencies,
        } satisfies CleanupEvidence;
      }),
    );

  const cleanupIncumbent: MissionManagerRuntimeAdapter["Service"]["cleanupIncumbent"] = (request) =>
    actions.withPermits(1)(
      Effect.gen(function* () {
        const { assignment, reservation } = yield* locate("cleanup", request);
        if (reservation === undefined) return yield* fail("cleanup")("scope_denied");
        const transfer = reservation.lifecycle?.transfer;
        const state = managerReservationState(reservation);
        // Only a routed, switched reservation may retire its incumbent, and
        // never the thread that owns the role now.
        if (
          (state !== "routing_confirmed" && state !== "retired") ||
          transfer === undefined ||
          assignment?.threadId === undefined ||
          assignment.threadId === reservation.currentThreadId ||
          assignment.epoch === undefined ||
          assignment.epoch < transfer.newEpoch
        ) {
          return hold("not_retirable");
        }
        const incumbent = ThreadId.make(reservation.currentThreadId);
        const inspected = yield* inspectIncumbent(reservation.currentThreadId);
        // Without a session receipt there is nothing to reconcile the release against.
        if (inspected.owned.length === 0) return hold("cleanup_incomplete");
        if (inspected.activeRun) return hold("incumbent_active");
        if (inspected.childDependencies !== "none") return hold("child_dependencies");

        // Stop the incumbent's own hold first, so nothing below can claim a
        // release that did not happen. A session that cannot be shared has
        // only the incumbent attached, so it is released outright, which stops
        // the process and records it stopped. A session that other threads may
        // share is only detached from the incumbent, so a worker on it keeps
        // its process.
        for (const entry of inspected.owned) {
          if (entry.released) continue;
          const providerSessionId = ProviderSessionId.make(entry.id);
          if (entry.shared === false) {
            yield* sessions.release({
              providerSessionId,
              reason: "manual_shutdown",
              detail: "Manager retired after epoch transfer.",
            });
          } else {
            yield* sessions.detach({
              providerSessionId,
              threadId: incumbent,
              detail: "Manager retired after epoch transfer.",
              revokeMcpCredential: true,
            });
          }
        }
        // Credentials belong to the thread, whether or not a session was live.
        yield* mcpRegistry.revokeThread(incumbent);
        McpProviderSession.clearMcpProviderSession(incumbent);
        // A released session says so in the projection. One that stays up for
        // other threads cannot, so record the incumbent's detach from it.
        for (const entry of inspected.owned) {
          if (entry.released || !entry.recorded || entry.shared !== true) continue;
          yield* threads.dispatch({
            type: "provider-session.detach",
            commandId: CommandId.make(
              `manager-retire:${reservation.reservationId}:detach:${entry.id}`,
            ),
            threadId: incumbent,
            providerSessionId: ProviderSessionId.make(entry.id),
            reason: "Manager retired after epoch transfer.",
          });
        }
        yield* advanceFence;
        // Verify against the sessions known before the detach: a recorded
        // detach removes a shared session from the projection.
        const after = yield* inspectIncumbent(
          reservation.currentThreadId,
          inspected.owned.map((entry) => entry.id),
        );
        if (!after.allReleased || !after.mcpReleased) return hold("cleanup_incomplete");
        return {
          kind: "released",
          sessionIds: inspected.owned.map((entry) => entry.id),
        } satisfies IncumbentCleanupOutcome;
      }).pipe(Effect.mapError(toError("cleanup"))),
    );

  // ------------------------------------------------------------------ wake

  const wakeCurrentRole: MissionManagerRuntimeAdapter["Service"]["wakeCurrentRole"] = (request) =>
    actions.withPermits(1)(
      Effect.gen(function* () {
        const located = yield* locate("wake", request);
        const { canonical, assignment } = located;
        if (canonical.status !== "active") return hold("mission_inactive");
        if (assignment?.threadId === undefined || assignment.epoch === undefined) {
          return hold("no_manager");
        }
        const expected = request.expectedOwner;
        if (
          expected !== undefined &&
          (expected.threadId !== assignment.threadId || expected.epoch !== assignment.epoch)
        ) {
          return hold("owner_changed");
        }
        // The target is whoever the canonical role names now; a standby
        // successor is not that until the switch commits, and a retired
        // incumbent no longer is.
        const target = ThreadId.make(assignment.threadId);
        const { thread: targetThread } = yield* threads.getThreadRecords(target, []);
        if (targetThread.archivedAt !== null || targetThread.deletedAt !== null) {
          return hold("no_manager");
        }
        const commandId = CommandId.make(
          `manager-wake:${canonical.id}:${request.role}:${assignment.epoch}:${request.wakeKey}`,
        );
        const header = `[manager-wake role=${request.role} epoch=${assignment.epoch} revision=${canonical.revision}]`;
        const ack =
          request.reservationId === undefined
            ? ""
            : `\nReread the mission at this revision, then reply with exactly this line when you are ready to act:\n${managerAckLine(
                {
                  reservationId: request.reservationId,
                  role: request.role,
                  epoch: assignment.epoch,
                  revision: canonical.revision,
                },
              )}`;
        // Queue behind any active turn: a wake must not steer the manager's work.
        yield* threads.sendToThread({
          projectId: targetThread.projectId,
          commandId,
          threadId: target,
          messageId: MessageId.make(`manager-wake-message:${commandId}`),
          text: `${header}\n${request.instruction}${ack}`,
          attachments: [],
          mode: "queue",
          createdBy: "system",
          creationSource: "server",
        });
        yield* advanceFence;
        return {
          kind: "sent",
          threadId: assignment.threadId,
          epoch: assignment.epoch,
          revision: canonical.revision,
          commandId,
        } satisfies WakeOutcome;
      }).pipe(Effect.mapError(toError("wake"))),
    );

  // ----------------------------------------------------------------- facts

  const readLifecycleFacts: MissionManagerRuntimeAdapter["Service"]["readLifecycleFacts"] = (
    request,
  ) =>
    Effect.gen(function* () {
      const { canonical, assignment, reservation } = yield* locate("observe", request);
      if (
        reservation === undefined ||
        assignment?.threadId === undefined ||
        assignment.epoch === undefined
      ) {
        return yield* fail("observe")("scope_denied");
      }
      const step = request.step;
      const routingReady =
        step === "transfer" && Option.isSome(boundary)
          ? yield* boundary.value
              .completionRoutingReady({ missionId: request.missionId, role: request.role })
              .pipe(Effect.catchDefect(() => Effect.succeed(null)))
          : null;
      const standby =
        step === "standby" || step === "transfer"
          ? yield* observeStandby(reservation, canonical.revision)
          : undefined;
      const quiesce =
        step === "quiesce" || step === "transfer"
          ? yield* observeQuiesce(request, reservation, assignment.epoch)
          : undefined;
      const routing = step === "routing" ? yield* observeRouting(reservation) : undefined;
      const cleanup = step === "retire" ? yield* observeCleanup(reservation) : undefined;
      return {
        teamId: authority.teamId,
        environmentId: authority.environmentId,
        missionId: canonical.id,
        role: request.role,
        reservationId: reservation.reservationId,
        step,
        currentThreadId: assignment.threadId,
        currentEpoch: assignment.epoch,
        observedRevision: canonical.revision,
        // The canonical status is the durable record of a user stop or pause.
        userStopRequested: canonical.status === "stopped",
        userPauseRequested: canonical.status === "paused",
        ...(step === "transfer" ? { completionRoutingReady: routingReady } : {}),
        ...(standby === undefined ? {} : { standby }),
        ...(quiesce === undefined ? {} : { quiesce }),
        ...(routing === undefined ? {} : { routing }),
        ...(cleanup === undefined ? {} : { cleanup }),
        fence: currentFence(),
      } satisfies ManagerLifecycleFacts;
    }).pipe(Effect.mapError(toError("observe")));

  return MissionManagerRuntimeAdapter.of({
    launchStandby,
    readLifecycleFacts,
    cleanupIncumbent,
    wakeCurrentRole,
    currentFence,
  });
});

export const layer = Layer.effect(MissionManagerRuntimeAdapter, make);

/**
 * The lifecycle store's required facts producer, backed by this adapter. A
 * producer failure keeps its category; the store treats it as a denied step.
 */
export const layerFactsPort = Layer.effect(
  MissionManagerLifecycleFactsPort,
  Effect.gen(function* () {
    const adapter = yield* MissionManagerRuntimeAdapter;
    return MissionManagerLifecycleFactsPort.of({
      readFacts: (request) =>
        adapter.readLifecycleFacts(request).pipe(
          Effect.mapError(
            (cause) =>
              new MissionManagerLifecycleStoreError({
                category: cause.category === "persistence" ? "persistence" : cause.category,
                cause,
              }),
          ),
        ),
      isCurrent: (facts) => facts.fence === adapter.currentFence(),
    });
  }),
);
