// @effect-diagnostics nodeBuiltinImport:off -- stable command hashes bind durable receipts.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  CommandId,
  EventId,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "../../../../packages/contracts/src/baseSchemas.ts";
import {
  Mission,
  type MissionManagerLifecycleAdvancedEvent,
} from "../../../../packages/contracts/src/mission.ts";
import {
  emptyMissionExecution,
  missionManagerReservations,
  type MissionExecution,
} from "../../../../packages/contracts/src/missionExecution.ts";
import {
  managerReservationState,
  MissionManagerReservation,
  type ManagerLifecycleProgress,
  type ManagerLifecycleState,
  type ManagerReservationLifecycle,
  type MissionManagerReservation as MissionManagerReservationValue,
} from "../../../../packages/contracts/src/missionManagerTransfer.ts";
import { Sha256Hex } from "../../../../packages/contracts/src/missionRetro.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";

/**
 * Durable source-only manager lifecycle transition store (P3).
 *
 * Advances one existing `reserved` successor intent through
 * `standby_ready -> quiesced -> transferred -> routing_confirmed -> retired`
 * on the canonical mission aggregate. It RECORDS trusted evidence; it never
 * launches a thread, stops or archives a provider session, tears down MCP
 * resources, or activates a runtime. Missing standby/cleanup adapters keep
 * the runtime dormant: without a private trusted producer reporting the
 * evidence, no step can commit.
 *
 * Authority and facts are two required private ports with NO default
 * producer. The authority is a root-held role binding (team, environment,
 * role); it is deliberately not bound to a manager thread, because a lost
 * ACK after the owner switch must still replay for the new owner. Every
 * safety fact comes from the facts port: the canonical manager it sees, the
 * user stop/pause state, and the per-step evidence (successor bootstrap ACK,
 * incumbent quiescence, routing confirmation, session cleanup). Callers
 * supply identity bindings only, never booleans. A missing or unknown fact
 * yields a finite hold; a mismatched or malformed one is denied.
 *
 * Holds are transient: they persist nothing, so a retry with the same
 * command id succeeds once the fact clears. Only a committed step writes the
 * dedicated `mission.manager-lifecycle-advanced` event, the reservation
 * lifecycle metadata, the projection CAS and the hash-bound command receipt
 * in ONE owning SQL transaction (no new table, migration or outbox). The
 * private callbacks are re-checked after every SQL yield and immediately
 * before commit, so a revoked authority or drifted fact rolls everything
 * back.
 *
 * The transfer step is the only place the canonical role owner changes: it
 * repoints the requested role at the reserved successor and increments that
 * role's epoch exactly once under the revision CAS, preserving the other
 * role and all other mission state. Replaying a committed transfer, routing
 * or retire command reads the durable receipt and the actual canonical
 * manager (it never reverts and never mints a new successor); it does not
 * require the old manager to still own the role.
 *
 * Quiescence must either prove no unmanaged shell or shared writes remain or
 * report a confirmed process/write fence; a token in a prompt is not a
 * fence. Independently owned child workers and worktrees are never touched:
 * retirement holds while any child dependency blocks or is unknown, and
 * requires the incumbent's own provider-session receipt, the session-owned
 * MCP release, and every expected owned resource released exactly.
 */
export class MissionManagerLifecycleStoreError extends Schema.TaggedError<MissionManagerLifecycleStoreError>()(
  "MissionManagerLifecycleStoreError",
  {
    category: Schema.Literals(["scope_denied", "request_conflict", "persistence"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Mission manager lifecycle failed (${this.category}).`;
  }
}

/** A finite, non-persisted hold: the step is not safe or not proven yet. */
export class MissionManagerLifecycleHold extends Schema.TaggedError<MissionManagerLifecycleHold>()(
  "MissionManagerLifecycleHold",
  {
    code: Schema.Literals([
      "facts_unknown",
      "mission_inactive",
      "user_stop",
      "user_pause",
      "unsafe_boundary",
      "routing_not_ready",
      "cleanup_incomplete",
      "child_dependencies",
    ]),
  },
) {
  override get message() {
    return `Manager lifecycle step held (${this.code}); nothing was recorded.`;
  }
}

export type ManagerLifecycleStep = "standby" | "quiesce" | "transfer" | "routing" | "retire";

/**
 * Strict identity-only command. No caller-owned authority, evidence, or
 * boolean fact is accepted: excess fields are rejected, never stripped.
 */
export interface ManagerLifecycleCommand {
  readonly commandId: CommandId;
  readonly missionId: string;
  readonly role: "delivery" | "retro";
  readonly reservationId: string;
  readonly step: ManagerLifecycleStep;
  /** Canonical revision the caller read; a stale value is a request conflict. */
  readonly expectedRevision: number;
}

/**
 * Required private lifecycle authority. Binds the actual team, environment,
 * and role from the trusted root; `isCurrent` is a pure synchronous check.
 * Not tied to a manager thread, so post-transfer replay stays possible.
 */
export class MissionManagerLifecycleAuthority extends Context.Service<
  MissionManagerLifecycleAuthority,
  {
    readonly teamId: string;
    readonly environmentId: string;
    readonly role: "delivery" | "retro";
    readonly isCurrent: () => boolean;
  }
>()("t3/orchestration-v2/MissionManagerLifecycleStore/MissionManagerLifecycleAuthority") {}

const BoundedId = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const Counter = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const RoleSchema = Schema.Literals(["delivery", "retro"]);
const StepSchema = Schema.Literals(["standby", "quiesce", "transfer", "routing", "retire"]);

/** Most owned resources one session cleanup receipt can name. */
const MAX_OWNED_RESOURCES = 16;
const OwnedResourceIds = Schema.Array(BoundedId).check(
  Schema.makeFilter((ids) => ids.length <= MAX_OWNED_RESOURCES, {
    expected: `at most ${MAX_OWNED_RESOURCES} owned resource ids`,
  }),
);

/** Successor bootstrap ACK: the exact identity the standby thread proved. */
const StandbyEvidence = Schema.Struct({
  reservationId: BoundedId,
  role: RoleSchema,
  successorThreadId: BoundedId,
  handoffSha256: Sha256Hex,
  /** Incumbent epoch and reservation revision the bootstrap was prepared against. */
  epoch: Counter,
  observedRevision: Counter,
  /** Latest canonical revision the successor independently reread after bootstrap. */
  reconciledRevision: Schema.optional(Counter),
  /** A standby thread must not dispatch work or hold the GUI lease. */
  dispatchEnabled: Schema.Boolean,
  guiLeaseHeld: Schema.Boolean,
  ackDigest: Sha256Hex,
});

/** Incumbent quiescence as reported by the trusted producer. */
const QuiesceEvidence = Schema.Struct({
  incumbentThreadId: BoundedId,
  incumbentEpoch: Counter,
  coordinatorTurnActive: Schema.Boolean,
  integrationRunning: Schema.Boolean,
  guiOwned: Schema.Boolean,
  unmanagedShellWrites: Schema.Literals(["none", "present", "unknown"]),
  sharedWrites: Schema.Literals(["none", "present", "unknown"]),
  /** Only `confirmed_*` kinds fence arbitrary writes; a prompt token never does. */
  fence: Schema.NullOr(
    Schema.Struct({
      kind: Schema.Literals(["confirmed_process_fence", "confirmed_write_fence", "prompt_token"]),
      digest: Sha256Hex,
    }),
  ),
});

/** Routing for the role resolved against the new owner and exact new epoch. */
const RoutingEvidence = Schema.Struct({
  role: RoleSchema,
  managerThreadId: BoundedId,
  epoch: Counter,
  confirmed: Schema.Boolean,
  confirmationDigest: Sha256Hex,
  /** Latest canonical revision the new manager reread after the epoch switch. */
  reconciledRevision: Schema.optional(Counter),
});

/** Separate receipts for the incumbent's provider session and its MCP resources. */
const CleanupEvidence = Schema.Struct({
  incumbentThreadId: BoundedId,
  providerSession: Schema.Struct({
    sessionDigest: Sha256Hex,
    ownerThreadId: BoundedId,
    released: Schema.Boolean,
  }),
  mcp: Schema.Struct({
    ownerSessionDigest: Sha256Hex,
    released: Schema.Boolean,
  }),
  ownedResources: Schema.Struct({ expectedIds: OwnedResourceIds, releasedIds: OwnedResourceIds }),
  /** Child workers or worker resources still depending on the session. */
  childDependencies: Schema.Literals(["none", "blocking", "unknown"]),
});

/**
 * Trusted captured facts, produced ONLY by the required private producer
 * and bound to the actual scope, reservation, step, canonical manager,
 * epoch and revision. `fence` is the producer revision token the
 * synchronous currency check compares. A section that is absent or null is
 * unknown and holds the step.
 */
const LifecycleFactsSchema = Schema.Struct({
  teamId: BoundedId,
  environmentId: BoundedId,
  missionId: BoundedId,
  role: RoleSchema,
  reservationId: BoundedId,
  step: StepSchema,
  /** Canonical manager the producer saw for the role, with its epoch and revision. */
  currentThreadId: BoundedId,
  currentEpoch: Counter,
  observedRevision: Counter,
  userStopRequested: Schema.NullOr(Schema.Boolean),
  userPauseRequested: Schema.NullOr(Schema.Boolean),
  completionRoutingReady: Schema.optional(Schema.NullOr(Schema.Boolean)),
  standby: Schema.optional(Schema.NullOr(StandbyEvidence)),
  quiesce: Schema.optional(Schema.NullOr(QuiesceEvidence)),
  routing: Schema.optional(Schema.NullOr(RoutingEvidence)),
  cleanup: Schema.optional(Schema.NullOr(CleanupEvidence)),
  fence: BoundedId,
});
export type ManagerLifecycleFacts = typeof LifecycleFactsSchema.Type;

/**
 * Required trusted lifecycle facts producer port. No default producer.
 * `readFacts` runs OUTSIDE the owning SQL transaction; `isCurrent` is a
 * pure synchronous check used before and after every own-SQL yield.
 */
export class MissionManagerLifecycleFactsPort extends Context.Service<
  MissionManagerLifecycleFactsPort,
  {
    readonly readFacts: (request: {
      readonly missionId: string;
      readonly role: "delivery" | "retro";
      readonly reservationId: string;
      readonly step: ManagerLifecycleStep;
    }) => Effect.Effect<ManagerLifecycleFacts, MissionManagerLifecycleStoreError>;
    readonly isCurrent: (facts: ManagerLifecycleFacts) => boolean;
  }
>()("t3/orchestration-v2/MissionManagerLifecycleStore/MissionManagerLifecycleFactsPort") {}

export interface ManagerLifecycleSuccess {
  /** The canonical reservation after this step, lifecycle metadata included. */
  readonly reservation: MissionManagerReservationValue;
  /** The actual canonical role manager now, which may be newer than this step. */
  readonly manager: { readonly threadId: string; readonly epoch: number };
  readonly receipt: Receipts.OrchestrationCommandReceipt;
  readonly recovered: boolean;
  /** True only when a fresh event, revision and accepted receipt committed. */
  readonly committed: boolean;
  readonly eventSequence: number;
}

export type ManagerLifecycleResult = Result.Result<
  ManagerLifecycleSuccess,
  MissionManagerLifecycleHold
>;

export class MissionManagerLifecycleStore extends Context.Service<
  MissionManagerLifecycleStore,
  {
    readonly advance: (
      command: ManagerLifecycleCommand,
    ) => Effect.Effect<ManagerLifecycleResult, MissionManagerLifecycleStoreError>;
  }
>()("t3/orchestration-v2/MissionManagerLifecycleStore") {}

/** Receipt command type for lifecycle transitions. */
export const MANAGER_LIFECYCLE_COMMAND_TYPE = "mission.manager-lifecycle-advance";

const ManagerLifecycleCommandSchema = Schema.Struct({
  commandId: CommandId.check(Schema.isMaxLength(512)),
  missionId: BoundedId,
  role: RoleSchema,
  reservationId: BoundedId,
  step: StepSchema,
  expectedRevision: Counter,
});
type DecodedCommand = typeof ManagerLifecycleCommandSchema.Type;

const requestHashFor = (command: DecodedCommand): string =>
  NodeCrypto.createHash("sha256")
    .update(
      stableStringify({
        commandId: command.commandId,
        expectedRevision: command.expectedRevision,
        missionId: command.missionId,
        reservationId: command.reservationId,
        role: command.role,
        step: command.step,
      }),
    )
    .digest("hex");

const digestOf = (value: unknown): string =>
  NodeCrypto.createHash("sha256").update(stableStringify(value), "utf8").digest("hex");

const STEP_TARGET: Record<ManagerLifecycleStep, ManagerLifecycleProgress> = {
  standby: "standby_ready",
  quiesce: "quiesced",
  transfer: "transferred",
  routing: "routing_confirmed",
  retire: "retired",
};
const STEP_PREDECESSOR: Record<ManagerLifecycleStep, ManagerLifecycleState> = {
  standby: "reserved",
  quiesce: "standby_ready",
  transfer: "quiesced",
  routing: "transferred",
  retire: "routing_confirmed",
};
/** Steps that move toward the owner switch are gated by active status and user intent. */
const isPreTransfer = (step: ManagerLifecycleStep): boolean =>
  step === "standby" || step === "quiesce" || step === "transfer";
/** Steps after the switch read the new owner; they never need the old one. */
const isPostTransfer = (step: ManagerLifecycleStep): boolean =>
  step === "routing" || step === "retire";

const milestoneOf = (
  lifecycle: ManagerReservationLifecycle | undefined,
  step: ManagerLifecycleStep,
) => {
  switch (step) {
    case "standby":
      return lifecycle?.standby;
    case "quiesce":
      return lifecycle?.quiesce;
    case "transfer":
      return lifecycle?.transfer;
    case "routing":
      return lifecycle?.routing;
    case "retire":
      return lifecycle?.retirement;
  }
};

const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));
const encodeMission = Schema.encodeEffect(Schema.fromJsonString(Mission));
const decodeReservation = Schema.decodeUnknownEffect(MissionManagerReservation);
const decodeCommand = Schema.decodeUnknownEffect(ManagerLifecycleCommandSchema, {
  onExcessProperty: "error",
});
const decodeFacts = Schema.decodeUnknownEffect(LifecycleFactsSchema, { onExcessProperty: "error" });
const isStoreError = Schema.is(MissionManagerLifecycleStoreError);

type HoldCode = MissionManagerLifecycleHold["code"];
type Verdict =
  | { readonly kind: "ok"; readonly evidence: unknown }
  | { readonly kind: "hold"; readonly code: HoldCode }
  | { readonly kind: "deny" };

const ok = (evidence: unknown): Verdict => ({ kind: "ok", evidence });
const hold = (code: HoldCode): Verdict => ({ kind: "hold", code });
const DENY: Verdict = { kind: "deny" };

const evaluateStandby = (
  evidence: ManagerLifecycleFacts["standby"],
  reservation: MissionManagerReservationValue,
  canonicalRevision: number,
): Verdict => {
  if (evidence === undefined || evidence === null) return hold("facts_unknown");
  if (
    evidence.reservationId !== reservation.reservationId ||
    evidence.role !== reservation.role ||
    evidence.successorThreadId !== reservation.successorThreadId ||
    evidence.handoffSha256 !== reservation.artifactSha256 ||
    evidence.epoch !== reservation.currentEpoch ||
    evidence.observedRevision !== reservation.observedRevision ||
    evidence.dispatchEnabled ||
    evidence.guiLeaseHeld
  ) {
    return DENY;
  }
  if (evidence.reconciledRevision === undefined) return hold("facts_unknown");
  if (evidence.reconciledRevision !== canonicalRevision) return hold("unsafe_boundary");
  return ok(evidence);
};

const evaluateQuiesce = (
  evidence: ManagerLifecycleFacts["quiesce"],
  reservation: MissionManagerReservationValue,
): Verdict => {
  if (evidence === undefined || evidence === null) return hold("facts_unknown");
  if (
    evidence.incumbentThreadId !== reservation.currentThreadId ||
    evidence.incumbentEpoch !== reservation.currentEpoch
  ) {
    return DENY;
  }
  if (evidence.coordinatorTurnActive || evidence.integrationRunning || evidence.guiOwned) {
    return hold("unsafe_boundary");
  }
  const fenced = evidence.fence !== null && evidence.fence.kind !== "prompt_token";
  if (fenced) return ok(evidence);
  if (evidence.unmanagedShellWrites === "present" || evidence.sharedWrites === "present") {
    return hold("unsafe_boundary");
  }
  if (evidence.unmanagedShellWrites === "unknown" || evidence.sharedWrites === "unknown") {
    return hold("facts_unknown");
  }
  return ok(evidence);
};

const evaluateRouting = (
  evidence: ManagerLifecycleFacts["routing"],
  reservation: MissionManagerReservationValue,
  canonicalRevision: number,
): Verdict => {
  if (evidence === undefined || evidence === null) return hold("facts_unknown");
  const transfer = reservation.lifecycle?.transfer;
  if (
    transfer === undefined ||
    evidence.role !== reservation.role ||
    evidence.managerThreadId !== reservation.successorThreadId ||
    evidence.epoch !== transfer.newEpoch
  ) {
    return DENY;
  }
  if (!evidence.confirmed) return hold("routing_not_ready");
  if (evidence.reconciledRevision === undefined) return hold("facts_unknown");
  if (evidence.reconciledRevision !== canonicalRevision) return hold("routing_not_ready");
  return ok(evidence);
};

const evaluateCleanup = (
  evidence: ManagerLifecycleFacts["cleanup"],
  reservation: MissionManagerReservationValue,
): Verdict => {
  if (evidence === undefined || evidence === null) return hold("facts_unknown");
  const { providerSession, mcp, ownedResources } = evidence;
  const expected = new Set(ownedResources.expectedIds);
  const released = new Set(ownedResources.releasedIds);
  if (
    // Only the retired incumbent's own session and the MCP resources that
    // session owns may be reported; never the successor's.
    evidence.incumbentThreadId !== reservation.currentThreadId ||
    providerSession.ownerThreadId !== reservation.currentThreadId ||
    mcp.ownerSessionDigest !== providerSession.sessionDigest ||
    expected.size !== ownedResources.expectedIds.length ||
    released.size !== ownedResources.releasedIds.length ||
    ![...released].every((id) => expected.has(id))
  ) {
    return DENY;
  }
  if (evidence.childDependencies === "unknown") return hold("facts_unknown");
  if (evidence.childDependencies === "blocking") return hold("child_dependencies");
  if (!providerSession.released || !mcp.released || released.size !== expected.size) {
    return hold("cleanup_incomplete");
  }
  return ok(evidence);
};

/** Pure evidence decision for one step from the trusted facts alone. */
const evaluateStep = (
  step: ManagerLifecycleStep,
  reservation: MissionManagerReservationValue,
  facts: ManagerLifecycleFacts,
): Verdict => {
  switch (step) {
    case "standby":
      return evaluateStandby(facts.standby, reservation, facts.observedRevision);
    case "quiesce":
      return evaluateQuiesce(facts.quiesce, reservation);
    case "transfer": {
      // The switch re-proves standby and quiescence from fresh facts.
      const standby = evaluateStandby(facts.standby, reservation, facts.observedRevision);
      if (standby.kind !== "ok") return standby;
      const quiesce = evaluateQuiesce(facts.quiesce, reservation);
      if (quiesce.kind !== "ok") return quiesce;
      if (facts.completionRoutingReady === undefined || facts.completionRoutingReady === null) {
        return hold("facts_unknown");
      }
      if (!facts.completionRoutingReady) return hold("routing_not_ready");
      return ok({
        standby: standby.evidence,
        quiesce: quiesce.evidence,
        completionRoutingReady: true,
      });
    }
    case "routing":
      return evaluateRouting(facts.routing, reservation, facts.observedRevision);
    case "retire":
      return evaluateCleanup(facts.cleanup, reservation);
  }
};

/** Active status and known user intent gate every step that moves toward the switch. */
const userIntentHold = (canonical: Mission, facts: ManagerLifecycleFacts): HoldCode | null => {
  if (canonical.status !== "active") return "mission_inactive";
  if (facts.userStopRequested === null || facts.userPauseRequested === null) return "facts_unknown";
  if (facts.userStopRequested) return "user_stop";
  if (facts.userPauseRequested) return "user_pause";
  return null;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authoritySvc = yield* MissionManagerLifecycleAuthority;
  const factsPort = yield* MissionManagerLifecycleFactsPort;
  const events = yield* EventStore.OrchestrationEventStore;
  const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;

  // Snapshot the private authority ONCE before any yield; keep only the pure
  // synchronous currency check by reference.
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
  const factsIsCurrent = (facts: ManagerLifecycleFacts): boolean => {
    try {
      return factsPort.isCurrent(facts) === true;
    } catch {
      return false;
    }
  };
  /** Both private callbacks must still be current. */
  const stillCurrent = (facts: ManagerLifecycleFacts): boolean =>
    authorityIsCurrent() && factsIsCurrent(facts);

  const toStoreError = (cause: unknown): MissionManagerLifecycleStoreError =>
    isStoreError(cause)
      ? cause
      : new MissionManagerLifecycleStoreError({ category: "persistence", cause });
  const scopeDenied = () => new MissionManagerLifecycleStoreError({ category: "scope_denied" });
  const requestConflict = () =>
    new MissionManagerLifecycleStoreError({ category: "request_conflict" });
  const persistenceFailed = () =>
    new MissionManagerLifecycleStoreError({ category: "persistence" });

  const advanceTransaction = Effect.fn("MissionManagerLifecycleStore.advanceTransaction")(
    function* (command: DecodedCommand, requestHash: string, facts: ManagerLifecycleFacts) {
      if (!stillCurrent(facts)) return yield* scopeDenied();
      const rows = yield* sql<{ revision: number; snapshot_json: string }>`
      SELECT revision, snapshot_json FROM projection_missions
      WHERE mission_id = ${command.missionId}
        AND team_id = ${authority.teamId}
        AND authority_environment_id = ${authority.environmentId}
    `;
      if (rows[0] === undefined) return yield* scopeDenied();
      const canonical = yield* decodeMission(rows[0].snapshot_json).pipe(
        Effect.mapError(toStoreError),
      );
      if (rows[0].revision !== canonical.revision) return yield* persistenceFailed();
      if (!stillCurrent(facts)) return yield* scopeDenied();

      const execution: MissionExecution = canonical.execution ?? emptyMissionExecution();
      const existing = missionManagerReservations(execution);
      const reservation = existing.find((entry) => entry.reservationId === command.reservationId);
      if (reservation === undefined || reservation.role !== command.role)
        return yield* scopeDenied();
      const state = managerReservationState(reservation);
      const assignment =
        command.role === "delivery" ? canonical.managers.delivery : canonical.managers.retro;
      // The trusted producer must describe the ACTUAL canonical manager, epoch
      // and revision: the incumbent before the switch, the successor after it.
      if (
        assignment?.threadId === undefined ||
        assignment.epoch === undefined ||
        facts.teamId !== authority.teamId ||
        facts.environmentId !== authority.environmentId ||
        facts.missionId !== canonical.id ||
        facts.role !== command.role ||
        facts.role !== authority.role ||
        facts.reservationId !== reservation.reservationId ||
        facts.step !== command.step ||
        facts.currentThreadId !== assignment.threadId ||
        facts.currentEpoch !== assignment.epoch ||
        facts.observedRevision !== canonical.revision
      ) {
        return yield* scopeDenied();
      }

      const prior = yield* receipts.getByCommandId({ commandId: command.commandId });
      if (!stillCurrent(facts)) return yield* scopeDenied();

      if (Option.isSome(prior)) {
        const saved = prior.value;
        if (
          saved.commandType !== MANAGER_LIFECYCLE_COMMAND_TYPE ||
          saved.aggregateKind !== "mission" ||
          saved.aggregateId !== canonical.id ||
          saved.requestHash !== requestHash
        ) {
          return yield* requestConflict();
        }
        // Only accepted steps are ever receipted; holds persist nothing.
        if (saved.status !== "accepted") return yield* persistenceFailed();
        // Replaying readiness (standby, quiesce) must not authorize anything
        // under a bad gate. A committed owner switch is different: its replay
        // only reports what already happened, so pause or stop cannot hide it.
        if (
          (command.step === "standby" || command.step === "quiesce") &&
          userIntentHold(canonical, facts) !== null
        ) {
          return yield* scopeDenied();
        }
        const logged = yield* events.readMissionEvents(canonical.id);
        const advanced = logged.find(
          (event) =>
            event.type === "mission.manager-lifecycle-advanced" &&
            event.sequence === saved.resultSequence,
        );
        if (advanced === undefined || advanced.type !== "mission.manager-lifecycle-advanced") {
          return yield* persistenceFailed();
        }
        if (
          advanced.payload.reservationId !== reservation.reservationId ||
          advanced.payload.to !== STEP_TARGET[command.step] ||
          advanced.commandId !== command.commandId
        ) {
          return yield* persistenceFailed();
        }
        const milestone = milestoneOf(reservation.lifecycle, command.step);
        if (milestone === undefined || milestone.commandId !== command.commandId)
          return yield* scopeDenied();
        // After the switch the role belongs to the successor (or a later owner);
        // the canonical epoch never goes backwards.
        const transfer = reservation.lifecycle?.transfer;
        if (isPostTransfer(command.step) || command.step === "transfer") {
          if (transfer === undefined || assignment.epoch < transfer.newEpoch)
            return yield* scopeDenied();
          if (
            assignment.epoch === transfer.newEpoch &&
            assignment.threadId !== reservation.successorThreadId
          ) {
            return yield* scopeDenied();
          }
        }
        if (!stillCurrent(facts)) return yield* scopeDenied();
        return Result.succeed({
          reservation,
          manager: { threadId: assignment.threadId, epoch: assignment.epoch },
          receipt: saved,
          recovered: true,
          committed: false,
          eventSequence: advanced.sequence,
        } satisfies ManagerLifecycleSuccess);
      }

      if (isPreTransfer(command.step)) {
        const intentHold = userIntentHold(canonical, facts);
        if (intentHold !== null)
          return Result.fail(new MissionManagerLifecycleHold({ code: intentHold }));
      }
      // Stale revision, out-of-order or already-applied step, and a canonical
      // owner that moved are all request conflicts: reread and reconcile.
      if (command.expectedRevision !== canonical.revision) return yield* requestConflict();
      if (state !== STEP_PREDECESSOR[command.step]) return yield* requestConflict();
      const expectedOwner = isPostTransfer(command.step)
        ? {
            threadId: reservation.successorThreadId,
            epoch: reservation.lifecycle?.transfer?.newEpoch,
          }
        : { threadId: reservation.currentThreadId, epoch: reservation.currentEpoch };
      if (
        assignment.threadId !== expectedOwner.threadId ||
        assignment.epoch !== expectedOwner.epoch
      ) {
        return yield* requestConflict();
      }

      const verdict = evaluateStep(command.step, reservation, facts);
      if (verdict.kind === "deny") return yield* scopeDenied();
      if (verdict.kind === "hold")
        return Result.fail(new MissionManagerLifecycleHold({ code: verdict.code }));
      if (!stillCurrent(facts)) return yield* scopeDenied();

      const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      const nextRevision = canonical.revision + 1;
      const milestone = {
        commandId: command.commandId,
        evidenceDigest: digestOf({
          step: command.step,
          reservationId: reservation.reservationId,
          role: reservation.role,
          evidence: verdict.evidence,
        }),
        revision: nextRevision,
        confirmedAt: now,
      };
      const previous = reservation.lifecycle;
      // `standby` is the only step with no earlier lifecycle record to extend.
      const lifecycle: ManagerReservationLifecycle | undefined = (() => {
        switch (command.step) {
          case "standby":
            return { state: "standby_ready", standby: milestone };
          case "quiesce":
            return previous === undefined
              ? undefined
              : { ...previous, state: "quiesced", quiesce: milestone };
          case "transfer":
            return previous === undefined
              ? undefined
              : {
                  ...previous,
                  state: "transferred",
                  transfer: {
                    ...milestone,
                    previousEpoch: reservation.currentEpoch,
                    newEpoch: reservation.currentEpoch + 1,
                  },
                };
          case "routing":
            return previous?.transfer === undefined
              ? undefined
              : {
                  ...previous,
                  state: "routing_confirmed",
                  routing: { ...milestone, epoch: previous.transfer.newEpoch },
                };
          case "retire":
            return previous === undefined
              ? undefined
              : { ...previous, state: "retired", retirement: milestone };
        }
      })();
      if (lifecycle === undefined) return yield* persistenceFailed();
      const advancedReservation = yield* decodeReservation({ ...reservation, lifecycle }).pipe(
        Effect.mapError(toStoreError),
      );
      if (!stillCurrent(facts)) return yield* scopeDenied();
      const managers =
        command.step !== "transfer"
          ? canonical.managers
          : command.role === "delivery"
            ? {
                ...canonical.managers,
                delivery: {
                  threadId: reservation.successorThreadId,
                  epoch: reservation.currentEpoch + 1,
                },
              }
            : {
                ...canonical.managers,
                retro: {
                  threadId: reservation.successorThreadId,
                  epoch: reservation.currentEpoch + 1,
                },
              };
      const updated: Mission = {
        ...canonical,
        revision: nextRevision,
        managers,
        execution: {
          ...execution,
          managerReservations: existing.map((entry) =>
            entry.reservationId === reservation.reservationId ? advancedReservation : entry,
          ),
        },
        updatedAt: now,
      };
      const event: MissionManagerLifecycleAdvancedEvent = {
        sequence: 0,
        eventId: EventId.make(NodeCrypto.randomUUID()),
        aggregateKind: "mission",
        aggregateId: canonical.id,
        occurredAt: now,
        commandId: command.commandId,
        metadata: {},
        type: "mission.manager-lifecycle-advanced",
        payload: {
          mission: updated,
          reservationId: reservation.reservationId,
          from: state,
          to: STEP_TARGET[command.step],
        },
      };
      const stored = yield* events.appendMissionEvent(event);
      if (!stillCurrent(facts)) return yield* scopeDenied();
      const snapshot = yield* encodeMission(updated);
      const cas = yield* sql<{ mission_id: string }>`
      UPDATE projection_missions
      SET revision = ${updated.revision}, snapshot_json = ${snapshot}, updated_at = ${now}
      WHERE mission_id = ${canonical.id}
        AND team_id = ${authority.teamId}
        AND authority_environment_id = ${authority.environmentId}
        AND revision = ${canonical.revision}
      RETURNING mission_id
    `;
      if (cas.length === 0) return yield* requestConflict();
      if (!stillCurrent(facts)) return yield* scopeDenied();
      const receipt: Receipts.OrchestrationCommandReceipt = {
        commandId: command.commandId,
        aggregateKind: "mission",
        aggregateId: canonical.id,
        commandType: MANAGER_LIFECYCLE_COMMAND_TYPE,
        acceptedAt: now,
        resultSequence: stored.sequence,
        status: "accepted",
        error: null,
        requestHash,
      };
      if (!(yield* receipts.insertIfAbsent(receipt))) return yield* requestConflict();
      // Final revocation check: rolling back here undoes event, CAS, and receipt.
      if (!stillCurrent(facts)) return yield* scopeDenied();
      const assigned = command.role === "delivery" ? managers.delivery : managers.retro;
      return Result.succeed({
        reservation: advancedReservation,
        manager: { threadId: assigned?.threadId ?? "", epoch: assigned?.epoch ?? 0 },
        receipt,
        recovered: false,
        committed: true,
        eventSequence: stored.sequence,
      } satisfies ManagerLifecycleSuccess);
    },
  );

  const advance = Effect.fn("MissionManagerLifecycleStore.advance")(function* (
    input: ManagerLifecycleCommand,
  ) {
    // Detach exactly once; clone-unsafe input is a finite error, not a defect.
    const detached = yield* Effect.try({
      try: () => structuredClone(input),
      catch: (cause) =>
        new MissionManagerLifecycleStoreError({ category: "request_conflict", cause }),
    });
    const command = yield* decodeCommand(detached).pipe(
      Effect.mapError((): MissionManagerLifecycleStoreError => requestConflict()),
    );
    if (!authorityIsCurrent() || command.role !== authority.role) return yield* scopeDenied();
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
      return yield* persistenceFailed();
    }
    // Trusted facts are read OUTSIDE the owning SQL transaction. Decoding
    // detaches them, so later port mutation cannot alter the bound facts.
    const rawFacts = yield* Effect.suspend(() =>
      factsPort.readFacts({
        missionId: command.missionId,
        role: command.role,
        reservationId: command.reservationId,
        step: command.step,
      }),
    ).pipe(Effect.catchDefect((cause) => Effect.fail(toStoreError(cause))));
    const detachedFacts = yield* Effect.try({
      try: () => structuredClone(rawFacts),
      catch: () => scopeDenied(),
    });
    const facts = yield* decodeFacts(detachedFacts).pipe(Effect.mapError(() => scopeDenied()));
    // Currency callbacks may inspect captured evidence, never mutate it into
    // a different decision while the owning SQL transaction is yielding.
    const freezeFacts = (value: unknown): void => {
      if (value !== null && typeof value === "object") {
        for (const nested of Object.values(value)) freezeFacts(nested);
        Object.freeze(value);
      }
    };
    freezeFacts(facts);
    if (!stillCurrent(facts)) return yield* scopeDenied();
    const requestHash = requestHashFor(command);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const outcome = yield* advanceTransaction(command, requestHash, facts);
          // Every branch, including replays and holds, is fenced at the
          // owning transaction boundary.
          if (!stillCurrent(facts)) return yield* scopeDenied();
          return outcome;
        }),
      )
      .pipe(Effect.mapError(toStoreError));
  });

  return MissionManagerLifecycleStore.of({
    advance: (command) => advance(command).pipe(Effect.mapError(toStoreError)),
  });
});

export const layer = Layer.effect(MissionManagerLifecycleStore, make);
