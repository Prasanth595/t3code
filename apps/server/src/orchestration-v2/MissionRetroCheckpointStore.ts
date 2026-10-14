// @effect-diagnostics nodeBuiltinImport:off -- stable command hashes bind durable receipts.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { CommandId, EventId } from "../../../../packages/contracts/src/baseSchemas.ts";
import {
  Mission,
  type MissionId,
  type MissionRetroCheckpointCapturedEvent,
} from "../../../../packages/contracts/src/mission.ts";
import {
  emptyMissionExecution,
  missionRetroCheckpoints,
  type MissionExecution,
} from "../../../../packages/contracts/src/missionExecution.ts";
import {
  ELIGIBLE_RETRO_COMPANY,
  MAX_MISSION_RETRO_CHECKPOINTS,
  MAX_MISSION_RETRO_OMISSIONS,
  MAX_MISSION_RETRO_SOURCE_REFS,
  MissionRetroCheckpoint,
  REQUESTED_RETRO_REPORTER,
  type MissionRetroCheckpoint as MissionRetroCheckpointValue,
} from "../../../../packages/contracts/src/missionRetro.ts";
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
import { MissionAuthority } from "./MissionService.ts";

/**
 * Dormant internal retro checkpoint store. Captures originating-thread
 * Retro checkpoint descriptors into the SAME canonical mission event log /
 * projection / command receipt transaction and queues them for later
 * analysis. No model is launched, no analysis lease is taken, no dispatcher
 * or outbox is wired, and no skills library is touched in this slice:
 * queued descriptors simply wait for a later analysis pass.
 *
 * A fresh capture appends one `mission.retro-checkpoint-captured` event
 * carrying the FULL updated mission, bumps the snapshot revision by one,
 * and records the command receipt atomically; a failed receipt insert rolls
 * everything back. An exact replay (same command id, same bytes) returns
 * the SAME saved checkpoint with no new event or revision. Same id with
 * different bytes is a request conflict. A different command id on the same
 * normalized boundary (team/env/mission + origin thread + range +
 * fingerprint) returns the SAME checkpoint with no new event, revision, or
 * job. Domain policy denials persist a rejected receipt; scope denials
 * persist nothing.
 *
 * The originating source thread recorded here is never the reporter child
 * that later analyzes the queued boundary, and no report-of-report is
 * derived from our own manual report or trial in this slice.
 */
export class MissionRetroCheckpointStoreError extends Schema.TaggedError<MissionRetroCheckpointStoreError>()(
  "MissionRetroCheckpointStoreError",
  {
    operation: Schema.Literals(["capture"]),
    category: Schema.Literals(["scope_denied", "request_conflict", "persistence"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Mission retro capture failed (${this.category}).`;
  }
}

/** Documented policy denial. Persisted as a rejected receipt: durable. */
export class MissionRetroPolicyRejection extends Schema.TaggedError<MissionRetroPolicyRejection>()(
  "MissionRetroPolicyRejection",
  {
    operation: Schema.Literal("capture"),
    code: Schema.Literals([
      "trigger_ineligible",
      "origin_denied",
      "source_mismatch",
      "range_invalid",
      "pending_children_complete",
      "checkpoint_bound",
    ]),
    message: Schema.String,
  },
) {}

/** Bounded capture command. The command id is the caller-stable idempotency key. */
export interface MissionRetroCaptureCommand {
  readonly commandId: CommandId;
  readonly missionId: string;
  readonly expectedRevision: number;
  readonly deliveryEpoch: number;
  readonly sourceThreadId: string;
  readonly fromInclusive: number;
  readonly toExclusive: number;
  /** Proposed trigger; validated against the eligible set and trusted eligibility. */
  readonly trigger: string;
}

/** One bounded source reference inside the trusted originating snapshot. */
export interface MissionRetroSnapshotSourceRef {
  readonly rootRef: string;
  readonly chunkRef: string;
  readonly chunkHash: string;
  readonly coveredFromInclusive: number;
  readonly coveredToExclusive: number;
}

/** Trusted capacity/account observations that decide queued_ready vs queued_capacity. */
export interface MissionRetroCapacityFacts {
  readonly state: "ready" | "unavailable" | "unknown";
  readonly accountId: string | null;
  readonly company: string | null;
  readonly reporterIdentity: string | null;
  readonly exhausted: boolean;
  readonly lowReserve: boolean;
  readonly profile: string | null;
}

/**
 * Trusted originating-thread snapshot. Supplied by the runtime through the
 * snapshot port, never by caller assertion: the store revalidates that the
 * returned root, range, and IDs match the command and runtime authority,
 * and never harvests other threads or teams. Immutable and redacted
 * upstream: no transcripts, secrets, or process arguments travel here.
 */
export interface MissionRetroTrustedSnapshot {
  readonly teamId: string;
  readonly environmentId: string;
  readonly deliveryThreadId: string;
  readonly deliveryEpoch: number;
  readonly nowMs: number;
  readonly missionId: string;
  readonly sourceRoot: string;
  readonly sourceThreadId: string;
  /** Trusted actual origin of the source work (not the caller's label). */
  readonly actualOrigin: string;
  /** Trusted eligibility reference for the proposed trigger. */
  readonly eligibleTrigger: string;
  readonly fromInclusive: number;
  readonly toExclusive: number;
  readonly snapshotFingerprint: string;
  readonly sourceRefs: ReadonlyArray<MissionRetroSnapshotSourceRef>;
  readonly omissions: ReadonlyArray<string>;
  readonly coverage: "full" | "partial" | "unknown";
  readonly pendingChildRuns: boolean;
  readonly capacity: MissionRetroCapacityFacts;
}

export class MissionRetroSnapshotPort extends Context.Service<
  MissionRetroSnapshotPort,
  {
    readonly readSnapshot: (
      command: MissionRetroCaptureCommand,
    ) => Effect.Effect<MissionRetroTrustedSnapshot, MissionRetroCheckpointStoreError>;
  }
>()("t3/orchestration-v2/MissionRetroCheckpointStore/MissionRetroSnapshotPort") {}

export interface MissionRetroCapture {
  readonly checkpoint: MissionRetroCheckpointValue;
  readonly receipt: Receipts.OrchestrationCommandReceipt;
  readonly recovered: boolean;
  /** True only when a fresh event, revision, and accepted receipt committed. */
  readonly committed: boolean;
  readonly eventSequence: number;
}

export type MissionRetroCaptureResult = Result.Result<
  MissionRetroCapture,
  MissionRetroPolicyRejection
>;

export class MissionRetroCheckpointStore extends Context.Service<
  MissionRetroCheckpointStore,
  {
    readonly capture: (
      command: MissionRetroCaptureCommand,
    ) => Effect.Effect<MissionRetroCaptureResult, MissionRetroCheckpointStoreError>;
  }
>()("t3/orchestration-v2/MissionRetroCheckpointStore") {}

/** Receipt command type for retro captures. */
export const RETRO_CAPTURE_COMMAND_TYPE = "mission.retro-capture";

/** Eligible capture triggers. Everything else, including routine work, is denied. */
export const ELIGIBLE_RETRO_TRIGGERS: ReadonlySet<string> = new Set([
  "milestone",
  "settled",
  "complete",
  "new_blocker",
  "compaction",
]);

/**
 * Actual origins that never produce an automatic checkpoint: reporter and
 * retro-pipeline work would be retro-of-retro, replay/triage/housekeeping
 * are manager internals, and routine tool/status/ACK work has no eligible
 * new source event. Denied even when the caller labels the work product.
 */
export const RECURSIVE_RETRO_ORIGINS: ReadonlySet<string> = new Set([
  "reporter",
  "retro_pipeline",
  "replay",
  "triage",
  "housekeeping",
]);

/**
 * Stable request hash over the canonical command bytes. The supplied expected revision is
 * part of the immutable request; retries must preserve the original bytes.
 */
export const requestHashFor = (command: MissionRetroCaptureCommand): string =>
  NodeCrypto.createHash("sha256")
    .update(
      stableStringify({
        commandId: command.commandId,
        expectedRevision: command.expectedRevision,
        deliveryEpoch: command.deliveryEpoch,
        fromInclusive: command.fromInclusive,
        missionId: command.missionId,
        sourceThreadId: command.sourceThreadId,
        toExclusive: command.toExclusive,
        trigger: command.trigger,
      }),
    )
    .digest("hex");

/** Normalized capture boundary: team/env/mission + origin thread + range + fingerprint. */
export const boundaryKeyFor = (boundary: {
  readonly teamId: string;
  readonly environmentId: string;
  readonly missionId: string;
  readonly sourceThreadId: string;
  readonly fromInclusive: number;
  readonly toExclusive: number;
  readonly snapshotFingerprint: string;
}): string => stableStringify(boundary);

/** Stable checkpoint id derived only from the normalized boundary. */
export const checkpointIdFor = (boundary: {
  readonly teamId: string;
  readonly environmentId: string;
  readonly missionId: string;
  readonly sourceThreadId: string;
  readonly fromInclusive: number;
  readonly toExclusive: number;
  readonly snapshotFingerprint: string;
}): string =>
  `retro-${NodeCrypto.createHash("sha256").update(boundaryKeyFor(boundary)).digest("hex").slice(0, 32)}`;

const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));
const encodeMission = Schema.encodeEffect(Schema.fromJsonString(Mission));
const decodeCheckpoint = Schema.decodeUnknownEffect(MissionRetroCheckpoint);
const decodeSavedRejection = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MissionRetroPolicyRejection),
);
const encodeRejection = Schema.encodeEffect(Schema.fromJsonString(MissionRetroPolicyRejection));
const isStoreError = Schema.is(MissionRetroCheckpointStoreError);

const sameBoundary = (
  checkpoint: MissionRetroCheckpointValue,
  boundary: {
    readonly teamId: string;
    readonly environmentId: string;
    readonly missionId: string;
    readonly sourceThreadId: string;
    readonly fromInclusive: number;
    readonly toExclusive: number;
    readonly snapshotFingerprint: string;
  },
): boolean =>
  checkpoint.teamId === boundary.teamId &&
  checkpoint.environmentId === boundary.environmentId &&
  checkpoint.missionId === boundary.missionId &&
  checkpoint.sourceThreadId === boundary.sourceThreadId &&
  checkpoint.coveredFromInclusive === boundary.fromInclusive &&
  checkpoint.coveredToExclusive === boundary.toExclusive &&
  checkpoint.snapshotFingerprint === boundary.snapshotFingerprint;

/** queued_ready only with a trusted eligible No Fun account, headroom, and reporter match. */
export const isReadyForAnalysis = (capacity: MissionRetroCapacityFacts): boolean =>
  capacity.state === "ready" &&
  capacity.accountId !== null &&
  capacity.company === ELIGIBLE_RETRO_COMPANY &&
  capacity.reporterIdentity === REQUESTED_RETRO_REPORTER &&
  !capacity.exhausted &&
  !capacity.lowReserve &&
  capacity.profile === "muse-review";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* MissionAuthority;
  const events = yield* EventStore.OrchestrationEventStore;
  const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
  const snapshotPort = yield* MissionRetroSnapshotPort;

  const toStoreError = (cause: unknown): MissionRetroCheckpointStoreError =>
    isStoreError(cause)
      ? cause
      : new MissionRetroCheckpointStoreError({
          operation: "capture",
          category: "persistence",
          cause,
        });

  const persistRejection = Effect.fn("MissionRetroCheckpointStore.persistRejection")(function* (
    command: MissionRetroCaptureCommand,
    missionId: MissionId,
    requestHash: string,
    failure: MissionRetroPolicyRejection,
  ) {
    const failedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    if (
      !(yield* receipts.insertIfAbsent({
        commandId: command.commandId,
        aggregateKind: "mission",
        aggregateId: missionId,
        commandType: RETRO_CAPTURE_COMMAND_TYPE,
        acceptedAt: failedAt,
        resultSequence: 0,
        status: "rejected",
        error: yield* encodeRejection(failure),
        requestHash,
      }))
    ) {
      return yield* new MissionRetroCheckpointStoreError({
        operation: "capture",
        category: "request_conflict",
      });
    }
    return Result.fail(failure);
  });

  const deny = (
    code: MissionRetroPolicyRejection["code"],
    message: string,
  ): MissionRetroPolicyRejection =>
    new MissionRetroPolicyRejection({ operation: "capture", code, message });

  const checkController = (
    canonical: Mission,
    trusted: MissionRetroTrustedSnapshot,
    command: MissionRetroCaptureCommand,
  ): boolean => {
    const delivery = canonical.managers.delivery;
    return (
      delivery?.threadId === authority.controllerThreadId &&
      delivery.epoch !== undefined &&
      delivery.epoch === trusted.deliveryEpoch &&
      delivery.epoch === command.deliveryEpoch &&
      trusted.deliveryThreadId === authority.controllerThreadId
    );
  };

  const captureTransaction = Effect.fn("MissionRetroCheckpointStore.captureTransaction")(function* (
    trusted: MissionRetroTrustedSnapshot,
    command: MissionRetroCaptureCommand,
    requestHash: string,
  ) {
    // Canonical reread scoped by the authenticated team/env precedes every
    // receipt lookup, including replay and boundary dedup of completed work.
    const rows = yield* sql<{ revision: number; snapshot_json: string }>`
      SELECT revision, snapshot_json FROM projection_missions
      WHERE mission_id = ${command.missionId}
        AND team_id = ${authority.teamId}
        AND authority_environment_id = ${authority.environmentId}
    `;
    if (rows[0] === undefined) {
      return yield* new MissionRetroCheckpointStoreError({
        operation: "capture",
        category: "scope_denied",
      });
    }
    const canonical = yield* decodeMission(rows[0].snapshot_json);
    if (rows[0].revision !== canonical.revision) {
      return yield* new MissionRetroCheckpointStoreError({
        operation: "capture",
        category: "persistence",
      });
    }
    if (trusted.teamId !== authority.teamId || trusted.environmentId !== authority.environmentId) {
      return yield* new MissionRetroCheckpointStoreError({
        operation: "capture",
        category: "scope_denied",
      });
    }
    // Latest delivery controller/epoch is revalidated even for replay,
    // before any receipt lookup.
    if (!checkController(canonical, trusted, command)) {
      return yield* new MissionRetroCheckpointStoreError({
        operation: "capture",
        category: "scope_denied",
      });
    }
    const prior = yield* receipts.getByCommandId({ commandId: command.commandId });
    if (Option.isSome(prior)) {
      const saved = prior.value;
      if (
        saved.commandType !== RETRO_CAPTURE_COMMAND_TYPE ||
        saved.aggregateKind !== "mission" ||
        saved.aggregateId !== canonical.id ||
        saved.requestHash !== requestHash
      ) {
        return yield* new MissionRetroCheckpointStoreError({
          operation: "capture",
          category: "request_conflict",
        });
      }
      if (saved.status === "rejected") {
        if (saved.error === null) {
          return yield* new MissionRetroCheckpointStoreError({
            operation: "capture",
            category: "persistence",
          });
        }
        return Result.fail(yield* decodeSavedRejection(saved.error).pipe(Effect.mapError(toStoreError)));
      }
      const logged = yield* events.readMissionEvents(canonical.id);
      const captured = logged.find(
        (event) => event.type === "mission.retro-checkpoint-captured" && event.sequence === saved.resultSequence,
      );
      if (captured === undefined || captured.type !== "mission.retro-checkpoint-captured") {
        return yield* new MissionRetroCheckpointStoreError({
          operation: "capture",
          category: "persistence",
        });
      }
      const checkpoint = (captured.payload.mission.execution?.retroCheckpoints ?? []).find(
        (entry) => entry.checkpointId === captured.payload.checkpointId,
      );
      if (checkpoint === undefined) {
        return yield* new MissionRetroCheckpointStoreError({
          operation: "capture",
          category: "persistence",
        });
      }
      return Result.succeed({
        checkpoint,
        receipt: saved,
        recovered: true,
        committed: false,
        eventSequence: captured.sequence,
      });
    }
    const execution: MissionExecution = canonical.execution ?? emptyMissionExecution();
    const boundary = {
      teamId: authority.teamId,
      environmentId: authority.environmentId,
      missionId: canonical.id,
      sourceThreadId: command.sourceThreadId,
      fromInclusive: command.fromInclusive,
      toExclusive: command.toExclusive,
      snapshotFingerprint: trusted.snapshotFingerprint,
    };
    const checkpointId = checkpointIdFor(boundary);
    const duplicate = missionRetroCheckpoints(execution).find((entry) => sameBoundary(entry, boundary));
    // Policy validation. Caller bytes are caller bytes: every trusted
    // snapshot field is revalidated against the command and the runtime
    // authority before anything is queued.
    if (!Number.isInteger(command.fromInclusive) || !Number.isInteger(command.toExclusive)) {
      return yield* persistRejection(
        command,
        canonical.id,
        requestHash,
        deny("range_invalid", "Capture range bounds must be integers."),
      );
    }
    if (
      command.fromInclusive < 0 ||
      command.toExclusive < 0 ||
      !(command.fromInclusive < command.toExclusive)
    ) {
      return yield* persistRejection(
        command,
        canonical.id,
        requestHash,
        deny("range_invalid", "Capture range must be ascending and non-empty."),
      );
    }
    if (!ELIGIBLE_RETRO_TRIGGERS.has(command.trigger) || trusted.eligibleTrigger !== command.trigger) {
      return yield* persistRejection(
        command,
        canonical.id,
        requestHash,
        deny(
          "trigger_ineligible",
          `Trigger '${command.trigger}' is not an eligible retro trigger with a trusted eligibility reference.`,
        ),
      );
    }
    if (RECURSIVE_RETRO_ORIGINS.has(trusted.actualOrigin)) {
      return yield* persistRejection(
        command,
        canonical.id,
        requestHash,
        deny(
          "origin_denied",
          `Actual origin '${trusted.actualOrigin}' never produces an automatic retro checkpoint.`,
        ),
      );
    }
    if (
      trusted.missionId !== command.missionId ||
      trusted.sourceThreadId !== command.sourceThreadId ||
      trusted.fromInclusive !== command.fromInclusive ||
      trusted.toExclusive !== command.toExclusive
    ) {
      return yield* persistRejection(
        command,
        canonical.id,
        requestHash,
        deny(
          "source_mismatch",
          "Trusted snapshot root, range, or IDs do not match the capture command.",
        ),
      );
    }
    if (trusted.sourceThreadId.length === 0 || trusted.sourceRoot.length === 0) {
      return yield* persistRejection(
        command,
        canonical.id,
        requestHash,
        deny("source_mismatch", "Trusted snapshot source thread and root must be set."),
      );
    }
    for (const ref of trusted.sourceRefs) {
      if (
        ref.rootRef !== trusted.sourceRoot ||
        !Number.isInteger(ref.coveredFromInclusive) ||
        !Number.isInteger(ref.coveredToExclusive) ||
        !(ref.coveredFromInclusive < ref.coveredToExclusive) ||
        ref.coveredFromInclusive < command.fromInclusive ||
        ref.coveredToExclusive > command.toExclusive
      ) {
        return yield* persistRejection(
          command,
          canonical.id,
          requestHash,
          deny("source_mismatch", "A trusted source ref falls outside the capture boundary."),
        );
      }
    }
    if (trusted.pendingChildRuns && command.trigger === "complete") {
      // Settled work with pending children must not pretend to be complete.
      return yield* persistRejection(
        command,
        canonical.id,
        requestHash,
        deny(
          "pending_children_complete",
          "Settled work with pending child runs cannot be captured as complete.",
        ),
      );
    }
    if (duplicate !== undefined) {
      // Same boundary, different command id: return the same checkpoint and
      // ref with no new event, revision, or analysis job. The accepted
      // receipt keeps this command id replay-stable.
      const logged = yield* events.readMissionEvents(canonical.id);
      const captured = logged.find(
        (event) =>
          event.type === "mission.retro-checkpoint-captured" &&
          event.payload.checkpointId === duplicate.checkpointId,
      );
      if (captured === undefined) {
        return yield* new MissionRetroCheckpointStoreError({
          operation: "capture",
          category: "persistence",
        });
      }
      const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      const receipt: Receipts.OrchestrationCommandReceipt = {
        commandId: command.commandId,
        aggregateKind: "mission",
        aggregateId: canonical.id,
        commandType: RETRO_CAPTURE_COMMAND_TYPE,
        acceptedAt: now,
        resultSequence: captured.sequence,
        status: "accepted",
        error: null,
        requestHash,
      };
      if (!(yield* receipts.insertIfAbsent(receipt))) {
        return yield* new MissionRetroCheckpointStoreError({
          operation: "capture",
          category: "request_conflict",
        });
      }
      return Result.succeed({
        checkpoint: duplicate,
        receipt,
        recovered: true,
        committed: false,
        eventSequence: captured.sequence,
      });
    }
    // Compare-and-swap on the canonical revision for fresh commands, only
    // after the exact receipt lookup above.
    if (command.expectedRevision !== canonical.revision) {
      return yield* new MissionRetroCheckpointStoreError({
        operation: "capture",
        category: "request_conflict",
      });
    }
    if (missionRetroCheckpoints(execution).length >= MAX_MISSION_RETRO_CHECKPOINTS) {
      // At the bound: deny and keep every retained descriptor. No dropping.
      return yield* persistRejection(
        command,
        canonical.id,
        requestHash,
        deny(
          "checkpoint_bound",
          "Mission retro checkpoint bound reached; history is preserved and no further checkpoints are accepted.",
        ),
      );
    }
    if (
      trusted.sourceRefs.length > MAX_MISSION_RETRO_SOURCE_REFS ||
      trusted.omissions.length +
        (trusted.pendingChildRuns && !trusted.omissions.includes("pending-child-runs") ? 1 : 0) >
        MAX_MISSION_RETRO_OMISSIONS
    ) {
      return yield* persistRejection(
        command,
        canonical.id,
        requestHash,
        deny("source_mismatch", "Trusted snapshot carries more refs or omissions than the bounded descriptor can persist."),
      );
    }
    // Coverage: only a clean full snapshot read stays full. Partial reads,
    // omissions, and pending children persist as unknown with their notes
    // intact; absent findings never imply clean coverage. Unknown capacity
    // or identity is queued, never dropped and never probed with a model.
    const omissions = [...trusted.omissions];
    if (trusted.pendingChildRuns && !omissions.includes("pending-child-runs")) {
      omissions.push("pending-child-runs");
    }
    const coverage = trusted.coverage === "full" && omissions.length === 0 ? "full" : "unknown";
    const status = isReadyForAnalysis(trusted.capacity) ? "queued_ready" : "queued_capacity";
    const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const checkpoint = yield* decodeCheckpoint({
      checkpointId,
      teamId: authority.teamId,
      environmentId: authority.environmentId,
      missionId: canonical.id,
      sourceThreadId: command.sourceThreadId,
      sourceRoot: trusted.sourceRoot,
      trigger: command.trigger,
      requestedReporter: REQUESTED_RETRO_REPORTER,
      status,
      coverage,
      snapshotFingerprint: trusted.snapshotFingerprint,
      coveredFromInclusive: command.fromInclusive,
      coveredToExclusive: command.toExclusive,
      sourceRefs: trusted.sourceRefs.map((ref) => ({ ...ref })),
      omissions,
      capturedAt: now,
    }).pipe(Effect.mapError(toStoreError));
    const nextExecution: MissionExecution = {
      ...execution,
      retroCheckpoints: [...missionRetroCheckpoints(execution), checkpoint],
    };
    const updated: Mission = {
      ...canonical,
      revision: canonical.revision + 1,
      execution: nextExecution,
      updatedAt: now,
    };
    const event: MissionRetroCheckpointCapturedEvent = {
      sequence: 0,
      eventId: EventId.make(NodeCrypto.randomUUID()),
      aggregateKind: "mission",
      aggregateId: canonical.id,
      occurredAt: now,
      commandId: command.commandId,
      metadata: {},
      type: "mission.retro-checkpoint-captured",
      payload: { mission: updated, checkpointId },
    };
    const stored = yield* events.appendMissionEvent(event);
    const snapshot = yield* encodeMission(updated);
    const cas = yield* sql<{ mission_id: string }>`
      UPDATE projection_missions
      SET revision = ${updated.revision}, snapshot_json = ${snapshot}, updated_at = ${now}
      WHERE mission_id = ${canonical.id} AND revision = ${canonical.revision}
      RETURNING mission_id
    `;
    if (cas.length === 0) {
      return yield* new MissionRetroCheckpointStoreError({
        operation: "capture",
        category: "request_conflict",
      });
    }
    const receipt: Receipts.OrchestrationCommandReceipt = {
      commandId: command.commandId,
      aggregateKind: "mission",
      aggregateId: canonical.id,
      commandType: RETRO_CAPTURE_COMMAND_TYPE,
      acceptedAt: now,
      resultSequence: stored.sequence,
      status: "accepted",
      error: null,
      requestHash,
    };
    if (!(yield* receipts.insertIfAbsent(receipt))) {
      return yield* new MissionRetroCheckpointStoreError({
        operation: "capture",
        category: "request_conflict",
      });
    }
    return Result.succeed({
      checkpoint,
      receipt,
      recovered: false,
      committed: true,
      eventSequence: stored.sequence,
    });
  });

  const capture = Effect.fn("MissionRetroCheckpointStore.capture")(function* (
    input: MissionRetroCaptureCommand,
  ) {
    const command = structuredClone(input);
    // A capture must never run inside an outer transaction: the trusted
    // snapshot read happens outside the owning transaction, and running
    // under a commit would leak that external read into it.
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
      return yield* new MissionRetroCheckpointStoreError({
        operation: "capture",
        category: "persistence",
      });
    }
    // Canonical scope and the authenticated current delivery
    // controller/epoch are checked before ANY receipt lookup or external
    // source read, and rechecked inside the transaction.
    const preRows = yield* sql<{ revision: number; snapshot_json: string }>`
      SELECT revision, snapshot_json FROM projection_missions
      WHERE mission_id = ${command.missionId}
        AND team_id = ${authority.teamId}
        AND authority_environment_id = ${authority.environmentId}
    `;
    if (preRows[0] === undefined) {
      return yield* new MissionRetroCheckpointStoreError({
        operation: "capture",
        category: "scope_denied",
      });
    }
    const preCanonical = yield* decodeMission(preRows[0].snapshot_json).pipe(
      Effect.mapError(toStoreError),
    );
    const preDelivery = preCanonical.managers.delivery;
    if (
      preDelivery?.threadId !== authority.controllerThreadId ||
      preDelivery.epoch === undefined ||
      preDelivery.epoch !== command.deliveryEpoch
    ) {
      return yield* new MissionRetroCheckpointStoreError({
        operation: "capture",
        category: "scope_denied",
      });
    }
    // Trusted observations are read before the transaction; no model
    // invocation, dispatch, or network happens inside it. Bind snapshots
    // rather than retaining mutable caller/port objects.
    const boundCommand = structuredClone(command);
    const trusted = structuredClone(yield* snapshotPort.readSnapshot(structuredClone(boundCommand)));
    const requestHash = requestHashFor(boundCommand);
    const runOnce = () =>
      sql
        .withTransaction(captureTransaction(trusted, boundCommand, requestHash))
        .pipe(Effect.mapError(toStoreError));
    const first = yield* runOnce().pipe(Effect.result);
    if (Result.isFailure(first)) {
      // A lost CAS race or receipt collision means a concurrent capture won;
      // reread once so an exact duplicate recovers instead of failing.
      if (first.failure.category !== "request_conflict") return yield* first.failure;
      const second = yield* runOnce().pipe(Effect.result);
      if (Result.isFailure(second)) return yield* second.failure;
      return second.success;
    }
    return first.success;
  });

  return MissionRetroCheckpointStore.of({
    capture: (command) => capture(command).pipe(Effect.mapError(toStoreError)),
  });
});

export const layer = Layer.effect(MissionRetroCheckpointStore, make);
