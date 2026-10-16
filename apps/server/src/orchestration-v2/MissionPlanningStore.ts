// @effect-diagnostics nodeBuiltinImport:off -- request hashes bind durable receipts.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { CommandId, MissionId } from "../../../../packages/contracts/src/baseSchemas.ts";
import { Mission } from "../../../../packages/contracts/src/mission.ts";
import {
  ProPlanningAction,
  ProPlanningCompletionReceipt,
  ProPlanningEvent,
  ProPlanningFacts,
  ProPlanningId,
  ProPlanningReasonCode,
  ProPlanningSubmitVerification,
  ProPlanningUsageFacts,
  type ProPlanningEvent as ProPlanningEventValue,
  type ProPlanningRecord as ProPlanningRecordValue,
  type ProPlanningReservationAck as ProPlanningReservationAckValue,
} from "../../../../packages/contracts/src/missionProPlanning.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import { MissionAuthority } from "./MissionService.ts";
import {
  PRO_PLANNING_GUI_ACTIONS,
  advanceProPlanning,
  inspectProPlanningRestart,
  proPlanningSqlDisposition,
  type ProPlanningDecision,
} from "./MissionProPlanning.ts";
import {
  MISSION_PLANNING_PROJECTION_SQL,
  decodePlanningRecordJson,
  decodeReceiptOutcome,
  decisionFromOutcome,
  durableLeaseOf,
  encodePlanningRecord,
  encodeReceiptOutcome,
  reservationAckFromRow,
  rowAgreesWithRecord,
  type MissionPlanningReceiptOutcome,
  type MissionPlanningReceiptRow,
  type MissionPlanningRow,
} from "./MissionPlanningProjection.ts";

export { MISSION_PLANNING_PROJECTION_SQL };

/**
 * Durable P5 planning projection.
 *
 * Commits proposal, reservation, GUI lease, completion, and restart guards
 * in one SQL transaction that first rereads `projection_missions` under
 * `MissionAuthority` (team, authority environment, current delivery thread
 * and epoch). The pure guard stays `proposal_only`. This store returns
 * `persistence: "committed"` only after `INSERT`/`UPDATE ... RETURNING`,
 * then rereads the row. A replay returns the stored decision with
 * `submitAuthorized: false` so a lost commit ACK cannot submit twice.
 * Restart never authorizes `submit_prompt`; a stale delivery-epoch GUI
 * lease is released and a submitted stage locates the existing conversation.
 *
 * No scheduler, provider, quota probe, or GUI call lives here. Root
 * registers `MISSION_PLANNING_PROJECTION_SQL` after `projection_missions`
 * and provides `MissionPlanningFactsPort` (usage and optional
 * approval/verification/completion only). There is no default port.
 */
export class MissionPlanningStoreError extends Schema.TaggedError<MissionPlanningStoreError>()(
  "MissionPlanningStoreError",
  {
    operation: Schema.Literals(["commit", "restart"]),
    category: Schema.Literals(["scope_denied", "request_conflict", "persistence"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Mission planning ${this.operation} failed (${this.category}).`;
  }
}

/** Guard hold. Nothing was written, so the same command may be retried. */
export class MissionPlanningHold extends Schema.TaggedError<MissionPlanningHold>()(
  "MissionPlanningHold",
  {
    code: Schema.Literals(["guard", "gui_lease_busy"]),
    reasons: Schema.Array(ProPlanningReasonCode),
    action: ProPlanningAction,
  },
) {
  override get message() {
    return `Mission planning held (${this.code}); nothing was written.`;
  }
}

/** Binding or ordering denial. Nothing was written. */
export class MissionPlanningDeny extends Schema.TaggedError<MissionPlanningDeny>()(
  "MissionPlanningDeny",
  {
    reasons: Schema.Array(ProPlanningReasonCode),
    action: Schema.Literal("operator_review"),
  },
) {
  override get message() {
    return "Mission planning denied; nothing was written.";
  }
}

/**
 * Trusted observations. Mission identity, revision, and delivery epoch come
 * from the canonical row, never from this port. The port must not submit,
 * spend, or schedule.
 */
export class MissionPlanningFactsPort extends Context.Service<
  MissionPlanningFactsPort,
  {
    readonly readFacts: (request: {
      readonly missionId: string;
      readonly planningId: string;
      readonly idempotencyKey: string;
      readonly eventType: ProPlanningEventValue["type"];
    }) => Effect.Effect<unknown, MissionPlanningStoreError>;
  }
>()("t3/orchestration-v2/MissionPlanningStore/MissionPlanningFactsPort") {}

export interface MissionPlanningOutcome {
  readonly operation: "commit" | "restart";
  /** `committed` is this call's write. `replayed` and `existing` are not a new persist. */
  readonly persistence: "committed" | "replayed" | "existing";
  readonly thisCallWrote: boolean;
  /** True when a projection row was read back. A proposal alone never sets this. */
  readonly recordPersisted: boolean;
  /** Fresh GUI commit only. Replay and restart are false, including lost submit ACKs. */
  readonly sideEffectAuthorized: boolean;
  /** Fresh `submit_prompt` commit only. Restart and replay never set this. */
  readonly submitAuthorized: boolean;
  readonly durableGuiLease: "held" | "released" | "absent";
  readonly decision: ProPlanningDecision;
  /** Insert-time reservation ACK, present only when that row was read back. */
  readonly reservation: ProPlanningReservationAckValue | null;
  readonly record: ProPlanningRecordValue | null;
}

export type MissionPlanningResult = Result.Result<
  MissionPlanningOutcome,
  MissionPlanningHold | MissionPlanningDeny
>;

export class MissionPlanningStore extends Context.Service<
  MissionPlanningStore,
  {
    readonly commit: (
      command: unknown,
    ) => Effect.Effect<MissionPlanningResult, MissionPlanningStoreError>;
    readonly restart: (
      command: unknown,
    ) => Effect.Effect<MissionPlanningResult, MissionPlanningStoreError>;
  }
>()("t3/orchestration-v2/MissionPlanningStore") {}

const Observations = Schema.Struct({
  observedAtMs: ProPlanningFacts.fields.observedAtMs,
  usage: ProPlanningUsageFacts,
  planningApproval: ProPlanningFacts.fields.planningApproval,
  scopeChangeApproval: ProPlanningFacts.fields.scopeChangeApproval,
  verification: Schema.optional(ProPlanningSubmitVerification),
  completion: Schema.optional(ProPlanningCompletionReceipt),
});
type Observations = typeof Observations.Type;

const CommitCommand = Schema.Struct({
  commandId: CommandId,
  missionId: ProPlanningId,
  event: ProPlanningEvent,
});
type CommitCommand = typeof CommitCommand.Type;

const RestartCommand = Schema.Struct({
  commandId: CommandId,
  missionId: ProPlanningId,
  planningId: ProPlanningId,
});
type RestartCommand = typeof RestartCommand.Type;

type DecoderSchema = Parameters<typeof Schema.decodeUnknownOption>[0];

const decoder = <S extends DecoderSchema>(schema: S) => {
  const decode = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" });
  return (input: unknown): S["Type"] | undefined => {
    try {
      const result = decode(input);
      return Option.isSome(result) ? result.value : undefined;
    } catch {
      return undefined;
    }
  };
};

const decodeCommit = decoder(CommitCommand);
const decodeRestart = decoder(RestartCommand);
const decodeObservations = decoder(Observations);
const decodeFacts = decoder(ProPlanningFacts);
const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));
const decodeMissionId = decoder(MissionId);
const isStoreError = Schema.is(MissionPlanningStoreError);

const sha256 = (value: unknown): string =>
  NodeCrypto.createHash("sha256").update(stableStringify(value)).digest("hex");

const seal = (input: {
  readonly operation: "commit" | "restart";
  readonly persistence: MissionPlanningOutcome["persistence"];
  readonly durableGuiLease: MissionPlanningOutcome["durableGuiLease"];
  readonly decision: ProPlanningDecision;
  readonly reservation: MissionPlanningOutcome["reservation"];
  readonly record: ProPlanningRecordValue | null;
}): MissionPlanningOutcome => {
  const thisCallWrote = input.persistence === "committed";
  const sideEffectAuthorized =
    thisCallWrote &&
    input.operation === "commit" &&
    PRO_PLANNING_GUI_ACTIONS.has(input.decision.action);
  return Object.freeze({
    operation: input.operation,
    persistence: input.persistence,
    thisCallWrote,
    recordPersisted: input.record !== null,
    sideEffectAuthorized,
    submitAuthorized: sideEffectAuthorized && input.decision.action === "submit_prompt",
    durableGuiLease: input.durableGuiLease,
    decision: input.decision,
    reservation: input.reservation,
    record: input.record,
  });
};

const hold = (decision: ProPlanningDecision): MissionPlanningResult =>
  Result.fail(
    new MissionPlanningHold({
      code: "guard",
      reasons: [...decision.reasons],
      action: decision.action,
    }),
  );

const deny = (decision: ProPlanningDecision): MissionPlanningResult =>
  Result.fail(
    new MissionPlanningDeny({
      reasons: [...decision.reasons],
      action: "operator_review",
    }),
  );

const leaseFor = (
  decision: ProPlanningDecision,
  threadId: string,
  epoch: number,
): {
  readonly guiLease: "held" | "released";
  readonly threadId: string | null;
  readonly epoch: number | null;
} =>
  decision.guiLease === "required" && PRO_PLANNING_GUI_ACTIONS.has(decision.action)
    ? { guiLease: "held", threadId, epoch }
    : { guiLease: "released", threadId: null, epoch: null };

const eventIdentity = (
  event: ProPlanningEventValue,
): { readonly planningId: string; readonly idempotencyKey: string } =>
  event.type === "prepare"
    ? { planningId: event.prepared.planningId, idempotencyKey: event.prepared.idempotencyKey }
    : { planningId: event.planningId, idempotencyKey: event.idempotencyKey };

const receiptOutcome = (
  operation: "commit" | "restart",
  decision: ProPlanningDecision,
  reservation: MissionPlanningOutcome["reservation"],
  record: ProPlanningRecordValue | null,
): MissionPlanningReceiptOutcome => ({
  schemaVersion: 1,
  operation,
  kind: decision.kind,
  action: decision.action,
  reasons: [...decision.reasons],
  decisionGuiLease: decision.guiLease,
  pointer: decision.pointer,
  record: decision.kind === "advance" ? record : decision.record,
  reservation,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* MissionAuthority;
  const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
  const factsPort = yield* MissionPlanningFactsPort;

  const toStoreError =
    (operation: "commit" | "restart") =>
    (cause: unknown): MissionPlanningStoreError =>
      isStoreError(cause)
        ? cause
        : new MissionPlanningStoreError({ operation, category: "persistence", cause });

  const scopeDenied = (operation: "commit" | "restart") =>
    new MissionPlanningStoreError({ operation, category: "scope_denied" });

  const conflict = (operation: "commit" | "restart") =>
    new MissionPlanningStoreError({ operation, category: "request_conflict" });

  const persistenceFailed = (operation: "commit" | "restart") =>
    new MissionPlanningStoreError({ operation, category: "persistence" });

  const loadMission = (operation: "commit" | "restart", missionId: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ revision: number; snapshot_json: string }>`
        SELECT revision, snapshot_json FROM projection_missions
        WHERE mission_id = ${missionId}
          AND team_id = ${authority.teamId}
          AND authority_environment_id = ${authority.environmentId}
      `;
      if (rows[0] === undefined) return yield* scopeDenied(operation);
      const mission = yield* decodeMission(rows[0].snapshot_json).pipe(
        Effect.mapError(() => persistenceFailed(operation)),
      );
      if (
        rows[0].revision !== mission.revision ||
        mission.id !== missionId ||
        mission.teamId !== authority.teamId ||
        mission.authorityEnvironmentId !== authority.environmentId
      ) {
        return yield* persistenceFailed(operation);
      }
      const delivery = mission.managers.delivery;
      if (delivery?.threadId !== authority.controllerThreadId || delivery.epoch === undefined) {
        return yield* scopeDenied(operation);
      }
      return { mission, deliveryThreadId: delivery.threadId, deliveryEpoch: delivery.epoch };
    });

  const loadPlanning = (missionId: string, planningId: string, idempotencyKey: string) =>
    sql<MissionPlanningRow>`
      SELECT
        planning_id, mission_id, team_id, authority_environment_id,
        idempotency_key, submission_id, record_revision, stage, record_json,
        gui_lease, lease_manager_thread_id, lease_manager_epoch,
        mission_revision_at_write, reservation_persisted_at_ms,
        reservation_manager_thread_id, reservation_manager_epoch,
        reservation_record_revision, reservation_mission_revision,
        reservation_prompt_revision, reservation_prompt_sha256, updated_at
      FROM projection_mission_planning
      WHERE team_id = ${authority.teamId}
        AND authority_environment_id = ${authority.environmentId}
        AND (planning_id = ${planningId} OR idempotency_key = ${idempotencyKey})
        AND mission_id = ${missionId}
    `;

  const loadReceipt = (commandId: string) =>
    sql<MissionPlanningReceiptRow>`
      SELECT
        command_id, mission_id, team_id, authority_environment_id,
        request_hash, planning_id, outcome_json, created_at
      FROM projection_mission_planning_receipts
      WHERE command_id = ${commandId}
    `;

  const rereadPlanning = (missionId: string, planningId: string) =>
    sql<MissionPlanningRow>`
      SELECT
        planning_id, mission_id, team_id, authority_environment_id,
        idempotency_key, submission_id, record_revision, stage, record_json,
        gui_lease, lease_manager_thread_id, lease_manager_epoch,
        mission_revision_at_write, reservation_persisted_at_ms,
        reservation_manager_thread_id, reservation_manager_epoch,
        reservation_record_revision, reservation_mission_revision,
        reservation_prompt_revision, reservation_prompt_sha256, updated_at
      FROM projection_mission_planning
      WHERE planning_id = ${planningId}
        AND mission_id = ${missionId}
        AND team_id = ${authority.teamId}
        AND authority_environment_id = ${authority.environmentId}
    `;

  const recordOf = (
    operation: "commit" | "restart",
    row: MissionPlanningRow,
  ): Effect.Effect<ProPlanningRecordValue, MissionPlanningStoreError> =>
    Effect.gen(function* () {
      const record = decodePlanningRecordJson(row.record_json);
      if (
        record === undefined ||
        !rowAgreesWithRecord(row, record) ||
        (row.gui_lease !== "held" && row.gui_lease !== "released")
      ) {
        return yield* persistenceFailed(operation);
      }
      return record;
    });

  const replay = (
    operation: "commit" | "restart",
    missionId: string,
    requestHash: string,
    commandId: CommandId,
  ) =>
    Effect.gen(function* () {
      const stored = (yield* loadReceipt(commandId))[0];
      const canonical = yield* receipts.getByCommandId({ commandId });
      if (stored === undefined && Option.isNone(canonical)) return undefined;
      if (stored === undefined || Option.isNone(canonical))
        return yield* persistenceFailed(operation);
      if (
        stored.team_id !== authority.teamId ||
        stored.authority_environment_id !== authority.environmentId ||
        stored.mission_id !== missionId ||
        canonical.value.aggregateKind !== "mission" ||
        canonical.value.aggregateId !== missionId ||
        canonical.value.requestHash !== requestHash ||
        stored.request_hash !== requestHash
      ) {
        return yield* stored.team_id !== authority.teamId ||
        stored.authority_environment_id !== authority.environmentId
          ? scopeDenied(operation)
          : conflict(operation);
      }
      const outcome = decodeReceiptOutcome(stored.outcome_json);
      const decision = outcome === undefined ? undefined : decisionFromOutcome(outcome);
      const row = (yield* rereadPlanning(missionId, stored.planning_id))[0];
      if (outcome === undefined || decision === undefined || row === undefined) {
        return yield* persistenceFailed(operation);
      }
      const record = yield* recordOf(operation, row);
      const reservation = outcome.reservation ?? reservationAckFromRow(row) ?? null;
      if (reservationAckFromRow(row) === undefined) return yield* persistenceFailed(operation);
      return seal({
        operation,
        persistence: "replayed",
        durableGuiLease: durableLeaseOf(row),
        decision,
        reservation,
        record,
      });
    });

  const writeReceipts = (
    operation: "commit" | "restart",
    commandId: CommandId,
    missionId: MissionId,
    requestHash: string,
    planningId: string,
    nowIso: string,
    revision: number,
    outcome: MissionPlanningReceiptOutcome,
  ) =>
    Effect.gen(function* () {
      const inserted = yield* sql<{ command_id: string }>`
        INSERT INTO projection_mission_planning_receipts (
          command_id, mission_id, team_id, authority_environment_id,
          request_hash, planning_id, outcome_json, created_at
        ) VALUES (
          ${commandId}, ${missionId}, ${authority.teamId}, ${authority.environmentId},
          ${requestHash}, ${planningId}, ${encodeReceiptOutcome(outcome)}, ${nowIso}
        )
        ON CONFLICT(command_id) DO NOTHING
        RETURNING command_id
      `;
      if (inserted.length !== 1) return yield* conflict(operation);
      const reserved = yield* receipts.insertIfAbsent({
        commandId,
        aggregateKind: "mission",
        aggregateId: missionId,
        commandType:
          operation === "commit" ? "mission.planning.commit" : "mission.planning.restart",
        acceptedAt: nowIso,
        resultSequence: revision,
        status: "accepted",
        error: null,
        requestHash,
      });
      if (!reserved) return yield* conflict(operation);
    });

  const otherLeaseHeld = (planningId: string) =>
    sql<{ planning_id: string }>`
      SELECT planning_id FROM projection_mission_planning
      WHERE authority_environment_id = ${authority.environmentId}
        AND gui_lease = 'held'
        AND planning_id != ${planningId}
      LIMIT 1
    `;

  const commitTransaction = (
    command: CommitCommand,
    observations: Observations,
    requestHash: string,
  ) =>
    Effect.gen(function* () {
      const loaded = yield* loadMission("commit", command.missionId);
      const prior = yield* replay("commit", command.missionId, requestHash, command.commandId);
      if (prior !== undefined) return Result.succeed(prior);

      const identity = eventIdentity(command.event);
      const matches = yield* loadPlanning(
        command.missionId,
        identity.planningId,
        identity.idempotencyKey,
      );
      if (matches.length > 1) return yield* conflict("commit");
      const row = matches[0];
      const current = row === undefined ? null : yield* recordOf("commit", row);
      const reservation = row === undefined ? undefined : reservationAckFromRow(row);
      if (row !== undefined && reservation === undefined) return yield* persistenceFailed("commit");

      const nowMs = yield* Clock.currentTimeMillis;
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) return yield* persistenceFailed("commit");
      const acceptanceDigest = sha256(loaded.mission.intent.acceptanceCriteria);
      const factsInput = {
        observedAtMs: observations.observedAtMs,
        mission: {
          missionId: loaded.mission.id,
          revision: loaded.mission.revision,
          teamId: loaded.mission.teamId,
          environmentId: loaded.mission.authorityEnvironmentId,
          managerThreadId: loaded.deliveryThreadId,
          managerEpoch: loaded.deliveryEpoch,
          status: loaded.mission.status,
          stopRequested: loaded.mission.status === "stopped",
          pauseRequested: loaded.mission.status === "paused",
          acceptanceDigest,
        },
        usage: observations.usage,
        ...(observations.planningApproval === undefined
          ? {}
          : { planningApproval: observations.planningApproval }),
        ...(observations.scopeChangeApproval === undefined
          ? {}
          : { scopeChangeApproval: observations.scopeChangeApproval }),
      };
      if (decodeFacts(factsInput) === undefined) return yield* persistenceFailed("commit");
      const evidence = {
        ...(observations.verification === undefined
          ? {}
          : { verification: observations.verification }),
        ...(reservation === undefined ? {} : { reservation }),
        ...(observations.completion === undefined ? {} : { completion: observations.completion }),
      };
      const decision = advanceProPlanning({
        event: command.event,
        current,
        facts: factsInput,
        evidence,
        nowMs,
      });
      if (decision.kind === "hold") return hold(decision);
      if (decision.kind === "deny") return deny(decision);
      const disposition = proPlanningSqlDisposition(decision);
      if (disposition === "none" || decision.kind === "noop") {
        return Result.succeed(
          seal({
            operation: "commit",
            persistence: "existing",
            durableGuiLease: durableLeaseOf(row),
            decision,
            reservation: reservation ?? null,
            record: current,
          }),
        );
      }

      const lease = leaseFor(decision, loaded.deliveryThreadId, loaded.deliveryEpoch);
      const planningId = decision.record?.planningId ?? row?.planning_id;
      if (planningId === undefined) return yield* persistenceFailed("commit");
      if (lease.guiLease === "held" && (yield* otherLeaseHeld(planningId)).length > 0) {
        return Result.fail(
          new MissionPlanningHold({ code: "gui_lease_busy", reasons: [], action: "none" }),
        );
      }

      const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
      const missionId = decodeMissionId(command.missionId);
      if (missionId === undefined) return yield* scopeDenied("commit");

      if (disposition === "record") {
        const next = decision.record;
        if (next === null) return yield* persistenceFailed("commit");
        if (row === undefined) {
          const inserted = yield* sql<{ planning_id: string }>`
            INSERT INTO projection_mission_planning (
              planning_id, mission_id, team_id, authority_environment_id,
              idempotency_key, submission_id, record_revision, stage, record_json,
              gui_lease, lease_manager_thread_id, lease_manager_epoch,
              mission_revision_at_write, reservation_persisted_at_ms,
              reservation_manager_thread_id, reservation_manager_epoch,
              reservation_record_revision, reservation_mission_revision,
              reservation_prompt_revision, reservation_prompt_sha256, updated_at
            ) VALUES (
              ${next.planningId}, ${command.missionId}, ${authority.teamId}, ${authority.environmentId},
              ${next.idempotencyKey}, ${next.submissionId}, ${next.revision}, ${next.stage},
              ${encodePlanningRecord(next)}, ${lease.guiLease}, ${lease.threadId}, ${lease.epoch},
              ${loaded.mission.revision}, ${nowMs}, ${next.managerThreadId}, ${next.managerEpoch},
              ${next.revision}, ${next.missionRevision}, ${next.prompt.revision}, ${next.prompt.sha256},
              ${nowIso}
            )
            ON CONFLICT(team_id, authority_environment_id, idempotency_key) DO NOTHING
            RETURNING planning_id
          `;
          if (inserted.length !== 1) return yield* conflict("commit");
        } else {
          if (next.revision !== row.record_revision + 1 || next.planningId !== row.planning_id) {
            return yield* persistenceFailed("commit");
          }
          const updated = yield* sql<{ planning_id: string }>`
            UPDATE projection_mission_planning
            SET record_revision = ${next.revision},
                stage = ${next.stage},
                record_json = ${encodePlanningRecord(next)},
                gui_lease = ${lease.guiLease},
                lease_manager_thread_id = ${lease.threadId},
                lease_manager_epoch = ${lease.epoch},
                mission_revision_at_write = ${loaded.mission.revision},
                updated_at = ${nowIso}
            WHERE planning_id = ${row.planning_id}
              AND mission_id = ${command.missionId}
              AND team_id = ${authority.teamId}
              AND authority_environment_id = ${authority.environmentId}
              AND record_revision = ${row.record_revision}
            RETURNING planning_id
          `;
          if (updated.length !== 1) return yield* conflict("commit");
        }
      } else {
        if (row === undefined) return yield* persistenceFailed("commit");
        const updated = yield* sql<{ planning_id: string }>`
          UPDATE projection_mission_planning
          SET gui_lease = ${lease.guiLease},
              lease_manager_thread_id = ${lease.threadId},
              lease_manager_epoch = ${lease.epoch},
              updated_at = ${nowIso}
          WHERE planning_id = ${row.planning_id}
            AND mission_id = ${command.missionId}
            AND team_id = ${authority.teamId}
            AND authority_environment_id = ${authority.environmentId}
            AND record_revision = ${row.record_revision}
          RETURNING planning_id
        `;
        if (updated.length !== 1) return yield* conflict("commit");
      }

      const written = (yield* rereadPlanning(command.missionId, planningId))[0];
      if (written === undefined) return yield* persistenceFailed("commit");
      const writtenRecord = yield* recordOf("commit", written);
      const writtenAck = reservationAckFromRow(written);
      if (writtenAck === undefined) return yield* persistenceFailed("commit");
      const decisionRecord = decision.record ?? writtenRecord;
      yield* writeReceipts(
        "commit",
        command.commandId,
        missionId,
        requestHash,
        written.planning_id,
        nowIso,
        written.record_revision,
        receiptOutcome("commit", decision, writtenAck, decisionRecord),
      );
      return Result.succeed(
        seal({
          operation: "commit",
          persistence: "committed",
          durableGuiLease: durableLeaseOf(written),
          decision,
          reservation: writtenAck,
          record: writtenRecord,
        }),
      );
    });

  const restartTransaction = (command: RestartCommand, requestHash: string) =>
    Effect.gen(function* () {
      const loaded = yield* loadMission("restart", command.missionId);
      const prior = yield* replay("restart", command.missionId, requestHash, command.commandId);
      if (prior !== undefined) return Result.succeed(prior);
      const row = (yield* rereadPlanning(command.missionId, command.planningId))[0];
      if (row === undefined) {
        return Result.fail(
          new MissionPlanningHold({
            code: "guard",
            reasons: ["record_missing"],
            action: "refresh_facts",
          }),
        );
      }
      const current = yield* recordOf("restart", row);
      const nowMs = yield* Clock.currentTimeMillis;
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) return yield* persistenceFailed("restart");
      const decision = inspectProPlanningRestart({
        current,
        nowMs,
        deliveryThreadId: loaded.deliveryThreadId,
        deliveryEpoch: loaded.deliveryEpoch,
      });
      // A record written under a newer epoch than this mission row is not ours to release.
      const recordAhead = current.managerEpoch > loaded.deliveryEpoch;
      if (decision.kind === "deny" && recordAhead) return deny(decision);

      const leaseForeign =
        row.gui_lease === "held" &&
        (row.lease_manager_epoch !== loaded.deliveryEpoch ||
          row.lease_manager_thread_id !== loaded.deliveryThreadId);
      if (!(leaseForeign && !recordAhead)) {
        if (decision.kind === "hold") return hold(decision);
        if (decision.kind === "deny") return deny(decision);
        const reservation = reservationAckFromRow(row);
        if (reservation === undefined) return yield* persistenceFailed("restart");
        return Result.succeed(
          seal({
            operation: "restart",
            persistence: "existing",
            durableGuiLease: durableLeaseOf(row),
            decision,
            reservation,
            record: current,
          }),
        );
      }

      const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
      const released = yield* sql<{ planning_id: string }>`
        UPDATE projection_mission_planning
        SET gui_lease = 'released',
            lease_manager_thread_id = NULL,
            lease_manager_epoch = NULL,
            updated_at = ${nowIso}
        WHERE planning_id = ${row.planning_id}
          AND mission_id = ${command.missionId}
          AND team_id = ${authority.teamId}
          AND authority_environment_id = ${authority.environmentId}
          AND record_revision = ${row.record_revision}
          AND gui_lease = 'held'
        RETURNING planning_id
      `;
      if (released.length !== 1) return yield* conflict("restart");
      const written = (yield* rereadPlanning(command.missionId, row.planning_id))[0];
      if (written === undefined || written.gui_lease !== "released") {
        return yield* persistenceFailed("restart");
      }
      const writtenRecord = yield* recordOf("restart", written);
      const reservation = reservationAckFromRow(written);
      if (reservation === undefined) return yield* persistenceFailed("restart");
      const missionId = decodeMissionId(command.missionId);
      if (missionId === undefined) return yield* scopeDenied("restart");
      yield* writeReceipts(
        "restart",
        command.commandId,
        missionId,
        requestHash,
        written.planning_id,
        nowIso,
        written.record_revision,
        receiptOutcome("restart", decision, reservation, writtenRecord),
      );
      // The lease release committed. A hold or deny decision still describes the
      // stage; it does not undo the release and it does not authorize submit.
      return Result.succeed(
        seal({
          operation: "restart",
          persistence: "committed",
          durableGuiLease: "released",
          decision,
          reservation,
          record: writtenRecord,
        }),
      );
    });

  const runOnce = <A>(
    operation: "commit" | "restart",
    body: Effect.Effect<A, MissionPlanningStoreError>,
  ) => sql.withTransaction(body).pipe(Effect.mapError(toStoreError(operation)));

  const commit = Effect.fn("MissionPlanningStore.commit")(function* (input: unknown) {
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
      return yield* persistenceFailed("commit");
    }
    const detached = yield* Effect.try({
      try: () => structuredClone(input),
      catch: (cause) =>
        new MissionPlanningStoreError({ operation: "commit", category: "request_conflict", cause }),
    });
    const command = decodeCommit(detached);
    if (command === undefined) {
      return hold({
        kind: "hold",
        authority: "proposal_only",
        reasons: ["input_malformed"],
        action: "refresh_facts",
        guiLease: "release",
        pointer: null,
        record: null,
      });
    }
    const identity = eventIdentity(command.event);
    const rawFacts = yield* factsPort
      .readFacts({
        missionId: command.missionId,
        planningId: identity.planningId,
        idempotencyKey: identity.idempotencyKey,
        eventType: command.event.type,
      })
      .pipe(
        Effect.catchDefect((cause) => Effect.fail(toStoreError("commit")(cause))),
        Effect.mapError(toStoreError("commit")),
      );
    const observations = decodeObservations(rawFacts);
    if (observations === undefined) return yield* persistenceFailed("commit");
    const frozen: Observations = structuredClone(observations);
    const requestHash = sha256(command.event);
    const attempt = () => runOnce("commit", commitTransaction(command, frozen, requestHash));
    const first = yield* attempt().pipe(Effect.result);
    if (Result.isFailure(first)) {
      if (first.failure.category !== "request_conflict") return yield* first.failure;
      return yield* attempt();
    }
    return first.success;
  });

  const restart = Effect.fn("MissionPlanningStore.restart")(function* (input: unknown) {
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
      return yield* persistenceFailed("restart");
    }
    const detached = yield* Effect.try({
      try: () => structuredClone(input),
      catch: (cause) =>
        new MissionPlanningStoreError({
          operation: "restart",
          category: "request_conflict",
          cause,
        }),
    });
    const command = decodeRestart(detached);
    if (command === undefined) {
      return hold({
        kind: "hold",
        authority: "proposal_only",
        reasons: ["input_malformed"],
        action: "refresh_facts",
        guiLease: "release",
        pointer: null,
        record: null,
      });
    }
    const requestHash = sha256({
      operation: "restart",
      missionId: command.missionId,
      planningId: command.planningId,
    });
    const attempt = () => runOnce("restart", restartTransaction(command, requestHash));
    const first = yield* attempt().pipe(Effect.result);
    if (Result.isFailure(first)) {
      if (first.failure.category !== "request_conflict") return yield* first.failure;
      return yield* attempt();
    }
    return first.success;
  });

  return MissionPlanningStore.of({ commit, restart });
});

export const layer = Layer.effect(MissionPlanningStore, make);
