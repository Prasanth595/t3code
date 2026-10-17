// @effect-diagnostics nodeBuiltinImport:off -- ack pointers are hashes, never raw secrets.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ProPlanningAction,
  ProPlanningId,
  ProPlanningReasonCode,
  ProPlanningRecord,
  ProPlanningReservationAck,
  ProPlanningStage,
  type ProPlanningReservationAck as ProPlanningReservationAckValue,
} from "../../../../packages/contracts/src/missionProPlanning.ts";
import type { ProPlanningDecision } from "./MissionProPlanning.ts";

/**
 * Root registers this DDL. This module does not run it and does not migrate
 * `projection_missions`. The planning row is a pointer beside the canonical
 * mission, keyed by the same team and authority environment.
 */
export const MISSION_PLANNING_PROJECTION_SQL = `
CREATE TABLE projection_mission_planning (
  planning_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  authority_environment_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  record_revision INTEGER NOT NULL,
  stage TEXT NOT NULL,
  record_json TEXT NOT NULL,
  gui_lease TEXT NOT NULL CHECK (gui_lease IN ('held', 'released')),
  lease_manager_thread_id TEXT,
  lease_manager_epoch INTEGER,
  mission_revision_at_write INTEGER NOT NULL,
  reservation_persisted_at_ms INTEGER NOT NULL,
  reservation_manager_thread_id TEXT NOT NULL,
  reservation_manager_epoch INTEGER NOT NULL,
  reservation_record_revision INTEGER NOT NULL,
  reservation_mission_revision INTEGER NOT NULL,
  reservation_prompt_revision INTEGER NOT NULL,
  reservation_prompt_sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (team_id, authority_environment_id, idempotency_key)
);
CREATE INDEX idx_projection_mission_planning_mission
  ON projection_mission_planning (mission_id, team_id, authority_environment_id);
-- The GUI belongs to this environment, not to an individual mission.
CREATE UNIQUE INDEX idx_projection_mission_planning_gui_owner
  ON projection_mission_planning (authority_environment_id) WHERE gui_lease = 'held';
CREATE TABLE projection_mission_planning_receipts (
  command_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  authority_environment_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  planning_id TEXT NOT NULL,
  outcome_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export interface MissionPlanningRow {
  readonly planning_id: string;
  readonly mission_id: string;
  readonly team_id: string;
  readonly authority_environment_id: string;
  readonly idempotency_key: string;
  readonly submission_id: string;
  readonly record_revision: number;
  readonly stage: string;
  readonly record_json: string;
  readonly gui_lease: string;
  readonly lease_manager_thread_id: string | null;
  readonly lease_manager_epoch: number | null;
  readonly mission_revision_at_write: number;
  readonly reservation_persisted_at_ms: number;
  readonly reservation_manager_thread_id: string;
  readonly reservation_manager_epoch: number;
  readonly reservation_record_revision: number;
  readonly reservation_mission_revision: number;
  readonly reservation_prompt_revision: number;
  readonly reservation_prompt_sha256: string;
  readonly updated_at: string;
}

export interface MissionPlanningReceiptRow {
  readonly command_id: string;
  readonly mission_id: string;
  readonly team_id: string;
  readonly authority_environment_id: string;
  readonly request_hash: string;
  readonly planning_id: string;
  readonly outcome_json: string;
  readonly created_at: string;
}

const Pointer = Schema.Struct({
  planningId: ProPlanningId,
  submissionId: ProPlanningId,
  stage: ProPlanningStage,
  recordRevision: Schema.Int.check(
    Schema.makeFilter((value: number) => value >= 0, { expected: "a non-negative revision" }),
  ),
});

export const MissionPlanningReceiptOutcome = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  operation: Schema.Literals(["commit", "restart"]),
  kind: Schema.Literals(["advance", "act", "noop", "hold", "deny"]),
  action: ProPlanningAction,
  reasons: Schema.Array(ProPlanningReasonCode),
  decisionGuiLease: Schema.Literals(["required", "release"]),
  pointer: Schema.NullOr(Pointer),
  record: Schema.NullOr(ProPlanningRecord),
  reservation: Schema.NullOr(ProPlanningReservationAck),
});
export type MissionPlanningReceiptOutcome = typeof MissionPlanningReceiptOutcome.Type;

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

const decodeRecord = decoder(ProPlanningRecord);
const decodeAck = decoder(ProPlanningReservationAck);
const decodeOutcome = decoder(MissionPlanningReceiptOutcome);

export const encodePlanningRecord = (record: ProPlanningRecord): string => stableStringify(record);

export const decodePlanningRecordJson = (json: string): ProPlanningRecord | undefined => {
  try {
    return decodeRecord(JSON.parse(json));
  } catch {
    return undefined;
  }
};

export const durableLeaseOf = (
  row: MissionPlanningRow | undefined,
): "held" | "released" | "absent" =>
  row === undefined ? "absent" : row.gui_lease === "held" ? "held" : "released";

/** ACK bytes are the insert-time snapshot. Later manager rebinding does not rewrite them. */
export const reservationAckFromRow = (
  row: MissionPlanningRow,
): ProPlanningReservationAckValue | undefined => {
  const ackRef = `planning-ack/${NodeCrypto.createHash("sha256").update(row.planning_id).digest("hex")}/r${row.reservation_record_revision}`;
  return decodeAck({
    ackRef,
    persistedAtMs: row.reservation_persisted_at_ms,
    planningId: row.planning_id,
    submissionId: row.submission_id,
    idempotencyKey: row.idempotency_key,
    promptRevision: row.reservation_prompt_revision,
    promptSha256: row.reservation_prompt_sha256,
    missionId: row.mission_id,
    missionRevision: row.reservation_mission_revision,
    managerThreadId: row.reservation_manager_thread_id,
    managerEpoch: row.reservation_manager_epoch,
    recordRevision: row.reservation_record_revision,
  });
};

export const decisionFromOutcome = (
  outcome: MissionPlanningReceiptOutcome,
): ProPlanningDecision | undefined => {
  if (outcome.kind === "advance" && outcome.record === null) return undefined;
  return Object.freeze({
    kind: outcome.kind,
    authority: "proposal_only",
    reasons: outcome.reasons,
    action: outcome.action,
    guiLease: outcome.decisionGuiLease,
    pointer: outcome.pointer,
    record: outcome.kind === "advance" ? outcome.record : null,
  });
};

export const encodeReceiptOutcome = (outcome: MissionPlanningReceiptOutcome): string =>
  stableStringify(outcome);

export const decodeReceiptOutcome = (json: string): MissionPlanningReceiptOutcome | undefined => {
  try {
    return decodeOutcome(JSON.parse(json));
  } catch {
    return undefined;
  }
};

export const rowAgreesWithRecord = (row: MissionPlanningRow, record: ProPlanningRecord): boolean =>
  row.planning_id === record.planningId &&
  row.mission_id === record.missionId &&
  row.idempotency_key === record.idempotencyKey &&
  row.submission_id === record.submissionId &&
  row.record_revision === record.revision &&
  row.stage === record.stage;
