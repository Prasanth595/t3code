import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";
import {
  ELIGIBLE_RETRO_COMPANY,
  REQUESTED_RETRO_REPORTER,
  RetroId,
  Sha256Hex,
} from "./missionRetro.ts";

/** Durable lease metadata only; source/report bodies never live here. */
export const MAX_MISSION_RETRO_ANALYSES = 64;
const Millis = Schema.Number.check(
  Schema.makeFilter((n) => Number.isFinite(n) && n >= 0, {
    expected: "finite nonnegative milliseconds",
  }),
);
const PositiveInt = NonNegativeInt.check(
  Schema.makeFilter((n) => n > 0, { expected: "positive integer" }),
);

/** Server-prepared identity. Reservation is not an atomic model-start claim. */
export const MissionRetroAnalysisLease = Schema.Struct({
  assignmentToken: Sha256Hex,
  reporterChildThreadId: RetroId,
  reporterRunId: RetroId,
  hostId: RetroId,
  bootId: RetroId,
  providerInstanceId: Schema.Literals(["muse-personal", "muse-backstage-support"]),
  modelId: Schema.Literal(REQUESTED_RETRO_REPORTER),
  profile: Schema.Literal("muse-review"),
  company: Schema.Literal(ELIGIBLE_RETRO_COMPANY),
  accountId: RetroId,
  verifiedAccountRef: RetroId,
  verifiedProviderRef: RetroId,
  capacityRef: RetroId,
  hostRef: RetroId,
  buildRef: RetroId,
  priorityRef: RetroId,
  preparedIdentityRef: RetroId,
  claimedAtMs: Millis,
  expiresAtMs: Millis,
  /** Canonical producing mission revision; report revision is stable within this attempt. */
  assignmentRevision: PositiveInt,
  reportRevision: PositiveInt,
}).check(
  Schema.makeFilter((lease) => lease.expiresAtMs > lease.claimedAtMs, {
    expected: "an ascending lease interval",
  }),
);
export type MissionRetroAnalysisLease = typeof MissionRetroAnalysisLease.Type;

export const MissionRetroAnalysisSettlement = Schema.Struct({
  status: Schema.Literals(["succeeded", "failed", "cancelled", "not_started"]),
  receiptRef: RetroId,
  observedAtMs: Millis,
});
export type MissionRetroAnalysisSettlement = typeof MissionRetroAnalysisSettlement.Type;

/** One record per immutable checkpoint. Retries remain held; no evidence is evicted. */
export const MissionRetroAnalysis = Schema.Struct({
  checkpointId: RetroId,
  teamId: RetroId,
  environmentId: RetroId,
  missionId: RetroId,
  sourceThreadId: RetroId,
  sourceRoot: RetroId,
  snapshotFingerprint: Sha256Hex,
  coveredFromInclusive: NonNegativeInt,
  coveredToExclusive: NonNegativeInt,
  managerThreadId: RetroId,
  managerEpoch: NonNegativeInt,
  status: Schema.Literals(["queued_capacity", "reserved", "uncertain", "settled"]),
  queueReason: Schema.NullOr(Schema.Literals(["capacity", "slot_busy"])),
  fence: NonNegativeInt,
  attemptNumber: NonNegativeInt,
  lease: Schema.NullOr(MissionRetroAnalysisLease),
  settlement: Schema.NullOr(MissionRetroAnalysisSettlement),
}).check(
  Schema.makeFilter(
    (record) =>
      record.coveredFromInclusive < record.coveredToExclusive &&
      (record.status === "queued_capacity"
        ? record.lease === null &&
          record.settlement === null &&
          record.fence === 0 &&
          record.attemptNumber === 0 &&
          record.queueReason !== null
        : record.lease !== null &&
          record.fence > 0 &&
          record.attemptNumber > 0 &&
          record.queueReason === null &&
          (record.status === "settled" ? record.settlement !== null : record.settlement === null)),
    { expected: "a consistent queued, owned, or terminal analysis record" },
  ),
);
export type MissionRetroAnalysis = typeof MissionRetroAnalysis.Type;

export const MissionRetroAnalyses = Schema.Array(MissionRetroAnalysis).check(
  Schema.makeFilter(
    (records) =>
      records.length <= MAX_MISSION_RETRO_ANALYSES &&
      new Set(records.map((record) => record.checkpointId)).size === records.length,
    { expected: `at most ${MAX_MISSION_RETRO_ANALYSES} unique checkpoint analyses` },
  ),
);
