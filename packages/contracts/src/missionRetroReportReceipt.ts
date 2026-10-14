import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt } from "./baseSchemas.ts";
import { ELIGIBLE_RETRO_COMPANY, RetroId, Sha256Hex } from "./missionRetro.ts";
import { REQUESTED_RETRO_REPORTER } from "./missionRetro.ts";

/**
 * Bounded durable receipt metadata for one received retro source report.
 * Leaf only: refs/hashes/IDs/verdict/disposition/coverage flags and short
 * reason refs. Full reports, the 128-incident index, transcripts, model
 * text, process args and secret values live in immutable artifacts OUTSIDE
 * the canonical mission snapshot; pointers identify the original report
 * input and the normalized report artifact separately, and the source
 * input hash differs from the normalized report hash after dedup.
 */
export const MAX_MISSION_RETRO_REPORT_RECEIPTS = 64;
export const MAX_MISSION_RETRO_REPORT_REASON_REFS = 8;
export const MAX_MISSION_RETRO_REPORT_QUARANTINE = 4;

const PositiveInt = NonNegativeInt.check(
  Schema.makeFilter((n) => n > 0, { expected: "positive integer" }),
);

export const MissionRetroReportDispositionValue = Schema.Literals([
  "queued_for_triage",
  "held_partial",
  "held_quarantined",
  "held_conflict",
]);
export type MissionRetroReportDispositionValue =
  typeof MissionRetroReportDispositionValue.Type;

export const MissionRetroReportVerdictValue = Schema.Literals([
  "no_change",
  "candidates",
  "partial_coverage",
]);
export type MissionRetroReportVerdictValue = typeof MissionRetroReportVerdictValue.Type;

/** One bounded quarantined variant: same revision, changed actual source hash. */
export const MissionRetroReportQuarantineEntry = Schema.Struct({
  originalArtifactRef: RetroId,
  originalArtifactSha: Sha256Hex,
  claimedSourceReportHash: Sha256Hex,
  sourceReportHash: Sha256Hex,
  normalizedReportHash: Sha256Hex,
  normalizedArtifactRef: RetroId,
  normalizedArtifactSha: Sha256Hex,
  coverageEvidenceRef: RetroId,
  coverageEvidenceSha: Sha256Hex,
  reasonRef: RetroId,
  receivedAt: IsoDateTime,
});
export type MissionRetroReportQuarantineEntry = typeof MissionRetroReportQuarantineEntry.Type;

const atMost =
  (limit: number) =>
  (values: ReadonlyArray<unknown>): boolean =>
    values.length <= limit;

export const MissionRetroReportReceipt = Schema.Struct({
  checkpointId: RetroId,
  teamId: RetroId,
  environmentId: RetroId,
  missionId: RetroId,
  sourceThreadId: RetroId,
  sourceRoot: RetroId,
  snapshotFingerprint: Sha256Hex,
  coveredFromInclusive: NonNegativeInt,
  coveredToExclusive: NonNegativeInt,
  reporterChildThreadId: RetroId,
  reporterRunId: RetroId,
  assignmentToken: Sha256Hex,
  fence: PositiveInt,
  attemptNumber: PositiveInt,
  reportRevision: PositiveInt,
  accountId: RetroId,
  providerInstanceId: Schema.Literals(["muse-personal", "muse-backstage-support"]),
  modelId: Schema.Literal(REQUESTED_RETRO_REPORTER),
  profile: Schema.Literal("muse-review"),
  company: Schema.Literal(ELIGIBLE_RETRO_COMPANY),
  /** Immutable original report artifact OUTSIDE the DB. */
  originalArtifactRef: RetroId,
  /** SHA-256 over the complete actual original descriptor bytes. */
  originalArtifactSha: Sha256Hex,
  /** Worker/command-claimed source hash; never trusted as the actual hash. */
  claimedSourceReportHash: Sha256Hex,
  /** Actual source INPUT hash over the decoded full report excluding reportHash. */
  sourceReportHash: Sha256Hex,
  /** Immutable normalized artifact OUTSIDE the DB; content-addressed/deduped. */
  normalizedArtifactRef: RetroId,
  normalizedArtifactSha: Sha256Hex,
  coverageEvidenceRef: RetroId,
  coverageEvidenceSha: Sha256Hex,
  /** Normalized report.reportHash; distinct from sourceReportHash after dedup/downgrade. */
  normalizedReportHash: Sha256Hex,
  verdict: MissionRetroReportVerdictValue,
  disposition: MissionRetroReportDispositionValue,
  coverageFull: Schema.Boolean,
  coverageReasonRefs: Schema.Array(RetroId).check(
    Schema.makeFilter(atMost(MAX_MISSION_RETRO_REPORT_REASON_REFS), {
      expected: `at most ${MAX_MISSION_RETRO_REPORT_REASON_REFS} reason refs`,
    }),
  ),
  /** Counts only; the complete incident index stays linked via the normalized artifact. */
  incidentCount: NonNegativeInt,
  shortlistCount: NonNegativeInt,
  incidentArtifactRef: RetroId,
  receivedAt: IsoDateTime,
  quarantine: Schema.Array(MissionRetroReportQuarantineEntry).check(
    Schema.makeFilter(atMost(MAX_MISSION_RETRO_REPORT_QUARANTINE), {
      expected: `at most ${MAX_MISSION_RETRO_REPORT_QUARANTINE} quarantine entries`,
    }),
  ),
}).check(
  Schema.makeFilter((r) => r.coveredFromInclusive < r.coveredToExclusive, {
    expected: "an ascending non-empty covered range",
  }),
);
export type MissionRetroReportReceipt = typeof MissionRetroReportReceipt.Type;

export const MissionRetroReportReceipts = Schema.Array(MissionRetroReportReceipt).check(
  Schema.makeFilter(
    (records) =>
      records.length <= MAX_MISSION_RETRO_REPORT_RECEIPTS &&
      new Set(records.map((r) => `${r.checkpointId}:${r.fence}:${r.attemptNumber}:${r.reportRevision}:${r.sourceReportHash}`)).size ===
        records.length,
    { expected: `at most ${MAX_MISSION_RETRO_REPORT_RECEIPTS} unique report receipts` },
  ),
);
export type MissionRetroReportReceipts = typeof MissionRetroReportReceipts.Type;
