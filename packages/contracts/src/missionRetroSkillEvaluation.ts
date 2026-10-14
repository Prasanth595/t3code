import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RetroId, Sha256Hex } from "./missionRetro.ts";

/**
 * Bounded canonical receipt metadata for one P2 skill-evaluation outcome.
 *
 * Source-only leaf: metadata bounds plausibility, nothing here proves a
 * genuine skill trigger, reviewer authority, or skill effectiveness. The
 * trusted independent replay artifact and the private producer that guards
 * it are future work owned elsewhere; the refs below are pointers, never
 * proof by themselves. No detail text, pair bodies, transcripts, expected
 * answers, provider credentials, or installed flags are stored here.
 *
 * Persistence is also future work: no store, event, command, transport, or
 * MCP change ships in this slice. The owning store (when it lands) supplies
 * guarded records; callers never forge them through generic create/replace.
 */

/** Maximum persisted skill-evaluation receipts per mission snapshot. */
export const MAX_MISSION_RETRO_SKILL_EVALUATIONS = 64;
/** Maximum observed pairs carried on one receipt across all three classes. */
export const MAX_SKILL_EVALUATION_OBSERVED_PAIRS = 64;
/** Maximum required pairs for one fixture class on one receipt. */
export const MAX_SKILL_EVALUATION_REQUIRED_PAIRS = 64;

/** Bounded deterministic outcome. Never a promotion, install, or authority grant. */
export const SkillEvaluationDecisionKind = Schema.Literals([
  "review_ready",
  "hold",
  "rejected",
  "no_change",
]);
export type SkillEvaluationDecisionKind = typeof SkillEvaluationDecisionKind.Type;

/** Finite hold/reject reason codes; unknown/missing evidence always holds. */
export const SkillEvaluationReasonCode = Schema.Literals([
  "ready_fix_verified",
  "no_change_identical",
  "hold_incomplete_pairs",
  "hold_missing_class",
  "hold_unknown_telemetry",
  "hold_leakage_unknown",
  "hold_not_independent",
  "hold_upstream_ownership",
  "hold_no_failure_reproduced",
  "hold_no_improvement",
  "hold_insufficient_samples",
  "hold_unstable_samples",
  "rejected_binding_drift",
  "rejected_snapshot_mismatch",
  "rejected_forged_receipt",
  "rejected_duplicate_run",
  "rejected_shared_context",
  "rejected_regression",
  "rejected_false_trigger",
  "rejected_load_regression",
  "rejected_leakage",
  "rejected_retarget",
]);
export type SkillEvaluationReasonCode = typeof SkillEvaluationReasonCode.Type;

/** The only kind each reason code may accompany. */
const KIND_FOR_REASON: Record<SkillEvaluationReasonCode, SkillEvaluationDecisionKind> = {
  ready_fix_verified: "review_ready",
  no_change_identical: "no_change",
  hold_incomplete_pairs: "hold",
  hold_missing_class: "hold",
  hold_unknown_telemetry: "hold",
  hold_leakage_unknown: "hold",
  hold_not_independent: "hold",
  hold_upstream_ownership: "hold",
  hold_no_failure_reproduced: "hold",
  hold_no_improvement: "hold",
  hold_insufficient_samples: "hold",
  hold_unstable_samples: "hold",
  rejected_binding_drift: "rejected",
  rejected_snapshot_mismatch: "rejected",
  rejected_forged_receipt: "rejected",
  rejected_duplicate_run: "rejected",
  rejected_shared_context: "rejected",
  rejected_regression: "rejected",
  rejected_false_trigger: "rejected",
  rejected_load_regression: "rejected",
  rejected_leakage: "rejected",
  rejected_retarget: "rejected",
};

const maxLength = (limit: number) =>
  Schema.makeFilter((value: string) => value.length <= limit, {
    expected: `at most ${limit} characters`,
  });

const inRange = (minimum: number, maximum: number) =>
  Schema.makeFilter((value: number) => value >= minimum && value <= maximum, {
    expected: `between ${minimum} and ${maximum}`,
  });

/**
 * Relative target-skill identifier metadata: never absolute, traversal, or
 * encoded traversal. Opaque to the receipt; the owning store resolves it.
 */
export const SkillEvaluationTargetSkillRef = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (value) => {
      if (value.length > 256) return false;
      if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
      // Any percent-encoding (including recursively encoded %252e) is unsafe here.
      if (value.includes("%")) return false;
      // Absolute URLs, schemes, and Windows drive paths are not relative refs.
      if (value.includes("://") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
      if (/^[a-zA-Z]:/.test(value)) return false;
      if (/(^|\/)\.\.(?=\/|$)/.test(value) || /(^|\/)\.(?=\/|$)/.test(value)) return false;
      // eslint-disable-next-line no-control-regex -- metadata must not carry control bytes.
      if (/[\x00-\x1f\x7f]/.test(value)) return false;
      return true;
    },
    { expected: "a relative skill ref up to 256 chars without traversal, encoding, or scheme" },
  ),
);
export type SkillEvaluationTargetSkillRef = typeof SkillEvaluationTargetSkillRef.Type;

/**
 * Content-addressed pointer to the future independent replay evidence
 * artifact. Metadata only: no artifact lives here and no filesystem is
 * touched; the suffix must equal the recorded evidence SHA.
 */
export const SkillEvaluationEvidenceArtifactRef = Schema.String.check(
  Schema.makeFilter((value) => /^skill-replay-evidence:[0-9a-f]{64}$/.test(value), {
    expected: "skill-replay-evidence:<lowercase SHA-256 hex>",
  }),
);
export type SkillEvaluationEvidenceArtifactRef =
  typeof SkillEvaluationEvidenceArtifactRef.Type;

/** Reviewer identity metadata (512 chars); metadata only, never authority. */
export const SkillEvaluationReviewerRef = TrimmedNonEmptyString.check(maxLength(512));
export type SkillEvaluationReviewerRef = typeof SkillEvaluationReviewerRef.Type;

/**
 * Opaque producing-thread identity (512 chars). Accepted as opaque bytes,
 * never decoded or interpreted here.
 */
export const SkillEvaluationRecordedByThreadId = TrimmedNonEmptyString.check(maxLength(512));
export type SkillEvaluationRecordedByThreadId =
  typeof SkillEvaluationRecordedByThreadId.Type;

/** Counters for one fixture class: required samples and observed pass counts. */
export const SkillEvaluationClassCounts = Schema.Struct({
  required: NonNegativeInt.check(inRange(1, MAX_SKILL_EVALUATION_REQUIRED_PAIRS)),
  observed: NonNegativeInt.check(inRange(0, MAX_SKILL_EVALUATION_OBSERVED_PAIRS)),
  oldPass: NonNegativeInt,
  newPass: NonNegativeInt,
}).check(
  Schema.makeFilter((counts) => counts.oldPass <= counts.observed && counts.newPass <= counts.observed, {
    expected: "pass counts within the observed samples",
  }),
);
export type SkillEvaluationClassCounts = typeof SkillEvaluationClassCounts.Type;

const allPass = (counts: SkillEvaluationClassCounts): boolean =>
  counts.oldPass === counts.observed && counts.newPass === counts.observed;

const coversRequired = (counts: SkillEvaluationClassCounts): boolean =>
  counts.observed >= counts.required;

/** One durable skill-evaluation receipt: bounded outcome metadata only. */
export const MissionRetroSkillEvaluation = Schema.Struct({
  evaluationId: RetroId,
  teamId: RetroId,
  environmentId: RetroId,
  missionId: RetroId,
  candidateId: RetroId,
  targetSkillRef: SkillEvaluationTargetSkillRef,
  sourceReportHash: Sha256Hex,
  normalizedReportHash: Sha256Hex,
  oldSkillSha256: Sha256Hex,
  newSkillSha256: Sha256Hex,
  kind: SkillEvaluationDecisionKind,
  reason: SkillEvaluationReasonCode,
  failurePairs: SkillEvaluationClassCounts,
  positivePairs: SkillEvaluationClassCounts,
  negativePairs: SkillEvaluationClassCounts,
  /** Bounded uncertainty: never infer a reliable gain beyond observed pairs. */
  uncertainty: Schema.Literal("observed_pairs_only"),
  evidenceArtifactRef: SkillEvaluationEvidenceArtifactRef,
  evidenceArtifactSha: Sha256Hex,
  reviewerRef: SkillEvaluationReviewerRef,
  recordedByThreadId: SkillEvaluationRecordedByThreadId,
  retroEpoch: NonNegativeInt,
  recordedAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (receipt) => {
      if (KIND_FOR_REASON[receipt.reason] !== receipt.kind) return false;
      if (receipt.evidenceArtifactRef !== `skill-replay-evidence:${receipt.evidenceArtifactSha}`) {
        return false;
      }
      const classes = [receipt.failurePairs, receipt.positivePairs, receipt.negativePairs];
      if (
        receipt.failurePairs.observed + receipt.positivePairs.observed + receipt.negativePairs.observed >
        MAX_SKILL_EVALUATION_OBSERVED_PAIRS
      ) {
        return false;
      }
      if (receipt.kind === "review_ready") {
        if (receipt.oldSkillSha256 === receipt.newSkillSha256) return false;
        if (!classes.every(coversRequired)) return false;
        if (receipt.failurePairs.oldPass !== 0) return false;
        if (receipt.failurePairs.newPass !== receipt.failurePairs.observed) return false;
        if (!allPass(receipt.positivePairs) || !allPass(receipt.negativePairs)) return false;
      }
      if (receipt.kind === "no_change") {
        if (receipt.oldSkillSha256 !== receipt.newSkillSha256) return false;
        if (!classes.every((counts) => coversRequired(counts) && allPass(counts))) return false;
      }
      return true;
    },
    { expected: "a kind/reason-consistent plausibly bounded evaluation receipt" },
  ),
);
export type MissionRetroSkillEvaluation = typeof MissionRetroSkillEvaluation.Type;

export const MissionRetroSkillEvaluations = Schema.Array(MissionRetroSkillEvaluation).check(
  Schema.makeFilter((records) => records.length <= MAX_MISSION_RETRO_SKILL_EVALUATIONS, {
    expected: `at most ${MAX_MISSION_RETRO_SKILL_EVALUATIONS} skill evaluation receipts`,
  }),
);
export type MissionRetroSkillEvaluations = typeof MissionRetroSkillEvaluations.Type;
