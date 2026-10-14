// Private pure P2 skill-candidate replay-evidence reconciliation.
//
// The canonical mission caller owns persistence: it supplies the trusted
// independent replay context (verified isolated snapshots, matched observed
// receipts from the independent reviewer, fixture/config identity) and
// persists/routes the returned decision later. This module performs no I/O,
// Effect, database, CLI, model, outbox, lease, runner, transport, or skill
// work of any kind: `reconcileSkillEvaluation` decodes the unknown worker
// input fail-closed and decides purely from the trusted context.
//
// Contract: an UNTRUSTED candidate's metadata/claimed receipts are reconciled
// AGAINST SEPARATE trusted independent replay context (same pattern as the
// untrusted-report + trusted-context report reconciler). A self-asserted
// worker pass boolean never creates review-ready. If trusted context is
// absent/unknown/mismatched the result is a finite hold; nothing here is
// ever promoted, installed, discovered, effective, or owner authority.
// A review_ready decision only queues the candidate for genuine review: no
// skill candidate execution or evaluation happens here.
import * as NodeBuffer from "node:buffer";

import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

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

export const SKILL_EVALUATION_FIXTURE_CLASSES = ["failure", "positive", "negative"] as const;
export type SkillEvaluationFixtureClass = (typeof SKILL_EVALUATION_FIXTURE_CLASSES)[number];

/** One trusted observed side of a paired old/new replay run. Digests and counters only. */
export interface SkillEvaluationTrustedObservation {
  readonly runRef: string;
  readonly contextId: string;
  readonly fixtureId: string;
  readonly fixtureHash: string;
  readonly configDigest: string;
  readonly observedSkillSha256: string;
  readonly outcome: "pass" | "fail";
  readonly skillTriggered: boolean;
  readonly unnecessaryLoads: number;
  readonly repeatedLookups: number;
  readonly completionQuality: "ok" | "degraded" | "unknown";
}

/** One trusted paired old/new run for a fixed fixture. */
export interface SkillEvaluationTrustedPair {
  readonly fixtureClass: SkillEvaluationFixtureClass;
  readonly old: SkillEvaluationTrustedObservation;
  readonly new: SkillEvaluationTrustedObservation;
}

/** Server-trusted scope + candidate binding. Caller-owned scope facts are never proof. */
export interface SkillEvaluationTrustedScope {
  readonly teamId: string;
  readonly environmentId: string;
  readonly originMissionId: string;
  readonly candidateId: string;
  /** Relative owned skill identifier metadata only (<=256 chars, no traversal). */
  readonly targetSkillRef: string;
  readonly sourceReportHash: string;
  readonly normalizedReportHash: string;
}

/**
 * Server-trusted independent replay context. Every field is supplied by the
 * runtime/root, never by the candidate worker. NOT public auth: the root
 * private producer remains future work and there is no default.
 */
export interface SkillEvaluationTrustedContext {
  readonly scope: SkillEvaluationTrustedScope;
  /** Author and independent reviewer identities; must differ. */
  readonly authorId: string;
  readonly reviewerId: string;
  /** Verified isolated old/new snapshot digests the observed hashes must match. */
  readonly oldSnapshotDigest: string;
  readonly newSnapshotDigest: string;
  /** Owned isolated snapshots required; upstream/unknown ownership stays held. */
  readonly ownership: "owned-isolated" | "upstream" | "unknown";
  /** Fixture hash + configuration/model/provider identity digest. */
  readonly configDigest: string;
  readonly runMode: "deterministic" | "stochastic";
  /** Explicit root-required paired sample count (>=2 when stochastic). */
  readonly requiredRepeatCount: number;
  /** Independently complete telemetry with no expected-answer leakage evidence. */
  readonly telemetryComplete: boolean;
  readonly leakageCheck: "pass" | "fail" | "unknown";
  /** Matched observed receipts from the independent reviewer. */
  readonly pairs: ReadonlyArray<SkillEvaluationTrustedPair>;
}

export interface SkillEvaluationClassCounts {
  readonly required: number;
  readonly observed: number;
  readonly oldPass: number;
  readonly newPass: number;
}

export interface SkillEvaluationDecision {
  readonly candidateId: string;
  readonly targetSkillRef: string;
  readonly sourceReportHash: string;
  readonly normalizedReportHash: string;
  readonly oldSkillSha256: string;
  readonly newSkillSha256: string;
  readonly kind: SkillEvaluationDecisionKind;
  readonly reason: SkillEvaluationReasonCode;
  readonly detail: string;
  readonly failurePairs: SkillEvaluationClassCounts;
  readonly positivePairs: SkillEvaluationClassCounts;
  readonly negativePairs: SkillEvaluationClassCounts;
  /** Bounded uncertainty: never infer a reliable gain beyond observed pairs. */
  readonly uncertainty: "observed_pairs_only";
}

export class SkillEvaluationReconciliationError extends Schema.TaggedError<SkillEvaluationReconciliationError>()(
  "SkillEvaluationReconciliationError",
  {
    operation: Schema.Literal("reconcile"),
    category: Schema.Literals([
      "malformed",
      "oversized",
      "unsafe_ref",
      "out_of_bounds",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Skill evaluation reconcile failed (${this.category}).`;
  }
}
export type SkillEvaluationReconciliationResult = Result.Result<
  SkillEvaluationDecision,
  SkillEvaluationReconciliationError
>;

const MAX_PAIRS = 64;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_ID_CHARS = 256;

const refuse = (
  category: SkillEvaluationReconciliationError["category"],
  detail: string,
): SkillEvaluationReconciliationResult =>
  Result.fail(new SkillEvaluationReconciliationError({ operation: "reconcile", category, detail }));

const decide = (
  context: SkillEvaluationTrustedContext,
  kind: SkillEvaluationDecisionKind,
  reason: SkillEvaluationReasonCode,
  detail: string,
  counts: Record<SkillEvaluationFixtureClass, SkillEvaluationClassCounts>,
): SkillEvaluationReconciliationResult =>
  Result.succeed(
    Object.freeze({
      candidateId: context.scope.candidateId,
      targetSkillRef: context.scope.targetSkillRef,
      sourceReportHash: context.scope.sourceReportHash,
      normalizedReportHash: context.scope.normalizedReportHash,
      oldSkillSha256: context.oldSnapshotDigest,
      newSkillSha256: context.newSnapshotDigest,
      kind,
      reason,
      detail,
      failurePairs: Object.freeze({ ...counts.failure }),
      positivePairs: Object.freeze({ ...counts.positive }),
      negativePairs: Object.freeze({ ...counts.negative }),
      uncertainty: "observed_pairs_only" as const,
    }),
  );

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const isBoundedId = (value: unknown): value is string =>
  isNonEmptyString(value) && value.length <= MAX_ID_CHARS;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && SHA256_HEX.test(value);

/** Relative target-skill identifier metadata: never absolute, traversal, or encoded traversal. */
const isSafeTargetSkillRef = (value: unknown): value is string => {
  if (!isBoundedId(value)) return false;
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
};

const ENVELOPE_KEYS = ["candidate", "context"] as const;
const CONTEXT_KEYS = [
  "authorId",
  "configDigest",
  "leakageCheck",
  "newSnapshotDigest",
  "oldSnapshotDigest",
  "ownership",
  "pairs",
  "requiredRepeatCount",
  "reviewerId",
  "runMode",
  "scope",
  "telemetryComplete",
] as const;
const SCOPE_KEYS = [
  "candidateId",
  "environmentId",
  "normalizedReportHash",
  "originMissionId",
  "sourceReportHash",
  "targetSkillRef",
  "teamId",
] as const;
const CANDIDATE_KEYS = ["candidateId", "claimedPass", "sourceReportHash", "targetSkillRef"] as const;
const PAIR_KEYS = ["fixtureClass", "new", "old"] as const;
const OBSERVATION_KEYS = [
  "completionQuality",
  "configDigest",
  "contextId",
  "fixtureHash",
  "fixtureId",
  "observedSkillSha256",
  "outcome",
  "repeatedLookups",
  "runRef",
  "skillTriggered",
  "unnecessaryLoads",
] as const;

const hasExactKeys = (value: unknown, keys: ReadonlyArray<string>): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
};

const isSafeIntegerCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

interface DecodedCandidate {
  readonly candidateId: string;
  readonly targetSkillRef: string;
  readonly sourceReportHash: string;
  readonly claimedPass: boolean;
}

const decodeCandidate = (input: unknown): DecodedCandidate | null => {
  if (!hasExactKeys(input, CANDIDATE_KEYS)) return null;
  const record = input as Record<string, unknown>;
  const { candidateId, targetSkillRef, sourceReportHash, claimedPass } = record;
  if (!isBoundedId(candidateId) || !isSafeTargetSkillRef(targetSkillRef)) return null;
  if (!isSha256(sourceReportHash)) return null;
  if (typeof claimedPass !== "boolean") return null;
  return { candidateId, targetSkillRef, sourceReportHash, claimedPass };
};

const validObservation = (value: unknown): value is SkillEvaluationTrustedObservation => {
  if (!hasExactKeys(value, OBSERVATION_KEYS)) return false;
  const o = value as Record<string, unknown>;
  return (
    isBoundedId(o.runRef) &&
    isBoundedId(o.contextId) &&
    isBoundedId(o.fixtureId) &&
    isSha256(o.fixtureHash) &&
    isSha256(o.configDigest) &&
    isSha256(o.observedSkillSha256) &&
    (o.outcome === "pass" || o.outcome === "fail") &&
    typeof o.skillTriggered === "boolean" &&
    isSafeIntegerCount(o.unnecessaryLoads) &&
    isSafeIntegerCount(o.repeatedLookups) &&
    (o.completionQuality === "ok" || o.completionQuality === "degraded" || o.completionQuality === "unknown")
  );
};

const validContextShape = (context: SkillEvaluationTrustedContext): boolean => {
  if (!hasExactKeys(context, CONTEXT_KEYS)) return false;
  const scope = context.scope;
  if (!hasExactKeys(scope, SCOPE_KEYS)) return false;
  if (
    !isBoundedId(scope.teamId) ||
    !isBoundedId(scope.environmentId) ||
    !isBoundedId(scope.originMissionId) ||
    !isBoundedId(scope.candidateId) ||
    !isSafeTargetSkillRef(scope.targetSkillRef) ||
    !isSha256(scope.sourceReportHash) ||
    !isSha256(scope.normalizedReportHash)
  ) {
    return false;
  }
  if (!isBoundedId(context.authorId) || !isBoundedId(context.reviewerId)) return false;
  if (!isSha256(context.oldSnapshotDigest) || !isSha256(context.newSnapshotDigest)) return false;
  if (context.ownership !== "owned-isolated" && context.ownership !== "upstream" && context.ownership !== "unknown") {
    return false;
  }
  if (!isSha256(context.configDigest)) return false;
  if (context.runMode !== "deterministic" && context.runMode !== "stochastic") return false;
  if (
    !Number.isSafeInteger(context.requiredRepeatCount) ||
    context.requiredRepeatCount < 1 ||
    context.requiredRepeatCount > MAX_PAIRS
  ) {
    return false;
  }
  if (typeof context.telemetryComplete !== "boolean") return false;
  if (context.leakageCheck !== "pass" && context.leakageCheck !== "fail" && context.leakageCheck !== "unknown") {
    return false;
  }
  if (!Array.isArray(context.pairs)) return false;
  return true;
};

const emptyCounts = (required: number): SkillEvaluationClassCounts => ({
  required,
  observed: 0,
  oldPass: 0,
  newPass: 0,
});

/**
 * Reconcile one UNTRUSTED skill candidate against SEPARATE trusted independent
 * replay context. Pure: no Effect, database, CLI, model, runner, transport, or
 * integration work. Proven contradictions reject; unknown/missing evidence
 * holds; only a fully matched clean independent 3-class replay is review_ready
 * (queued for genuine review, never installed or authoritative).
 */
export const reconcileSkillEvaluation = (input: {
  readonly context: SkillEvaluationTrustedContext;
  readonly candidate: unknown;
}): SkillEvaluationReconciliationResult => {
  // Detach the whole unknown envelope once, safely, before any validation.
  // Clone/getter/serialization failures are finite, never thrown.
  let detached: unknown;
  try {
    detached = structuredClone(input);
  } catch {
    return refuse("malformed", "The evaluation envelope could not be detached safely.");
  }
  if (!hasExactKeys(detached, ENVELOPE_KEYS)) {
    return refuse("malformed", "The evaluation envelope is malformed.");
  }
  const envelope = detached as {
    readonly context: SkillEvaluationTrustedContext;
    readonly candidate: unknown;
  };
  // Whole-envelope serialized bound (context + candidate), not pairs alone.
  let envelopeBytes = 0;
  try {
    envelopeBytes = NodeBuffer.Buffer.byteLength(stableStringify(envelope), "utf8");
  } catch {
    return refuse("malformed", "The evaluation envelope is not stable-serializable.");
  }
  if (envelopeBytes > MAX_METADATA_BYTES) {
    return refuse("oversized", "The evaluation envelope exceeds the metadata bound.");
  }
  const context = envelope.context;
  if (typeof context !== "object" || context === null || !validContextShape(context)) {
    return refuse("malformed", "The trusted replay context is malformed or unbounded.");
  }

  const candidate = decodeCandidate(envelope.candidate);
  if (candidate === null) {
    return refuse("malformed", "The candidate metadata does not decode as bounded evaluation metadata.");
  }
  if (!isSafeTargetSkillRef(context.scope.targetSkillRef)) {
    return refuse("unsafe_ref", "The trusted target skill identifier is unsafe.");
  }

  if (context.pairs.length > MAX_PAIRS) {
    return refuse("oversized", "The trusted pair bound is exceeded.");
  }
  for (const pair of context.pairs) {
    if (
      !hasExactKeys(pair, PAIR_KEYS) ||
      !SKILL_EVALUATION_FIXTURE_CLASSES.includes(
        (pair as SkillEvaluationTrustedPair).fixtureClass,
      ) ||
      !validObservation((pair as SkillEvaluationTrustedPair).old) ||
      !validObservation((pair as SkillEvaluationTrustedPair).new)
    ) {
      return refuse("malformed", "A trusted pair carries malformed observations.");
    }
  }

  const required =
    context.runMode === "stochastic" ? Math.max(context.requiredRepeatCount, 2) : context.requiredRepeatCount;
  const counts: Record<SkillEvaluationFixtureClass, SkillEvaluationClassCounts> = {
    failure: emptyCounts(required),
    positive: emptyCounts(required),
    negative: emptyCounts(required),
  };

  // Scope + candidate binding: exact match only. A worker mutation that
  // retargets the candidate, scope, or source report is a proven mismatch.
  if (
    candidate.candidateId !== context.scope.candidateId ||
    candidate.targetSkillRef !== context.scope.targetSkillRef
  ) {
    return decide(
      context,
      "rejected",
      "rejected_retarget",
      "Rejected: the candidate retargets scope outside the trusted binding.",
      counts,
    );
  }
  if (candidate.sourceReportHash !== context.scope.sourceReportHash) {
    return decide(
      context,
      "rejected",
      "rejected_binding_drift",
      "Rejected: the candidate source binding drifts from the trusted report hash.",
      counts,
    );
  }

  // Ownership + reviewer independence gate before any behavior claim.
  if (context.ownership !== "owned-isolated") {
    return decide(
      context,
      "hold",
      "hold_upstream_ownership",
      "Held: upstream or unknown ownership never changes the allowlist.",
      counts,
    );
  }
  if (context.authorId === context.reviewerId) {
    return decide(
      context,
      "hold",
      "hold_not_independent",
      "Held: the reviewer must be independent of the author.",
      counts,
    );
  }
  if (context.leakageCheck === "fail") {
    return decide(context, "rejected", "rejected_leakage", "Rejected: expected-answer leakage evidence.", counts);
  }
  if (context.leakageCheck !== "pass" || context.telemetryComplete !== true) {
    return decide(
      context,
      "hold",
      context.leakageCheck !== "pass" ? "hold_leakage_unknown" : "hold_unknown_telemetry",
      "Held: telemetry or leakage evidence is incomplete.",
      counts,
    );
  }

  // Pair integrity: unique run refs and fresh distinct clean contexts.
  const seenRunRefs = new Map<string, string>();
  const seenContexts = new Set<string>();
  const fixtureByClass = new Map<SkillEvaluationFixtureClass, string>();
  for (const pair of context.pairs) {
    for (const side of [pair.old, pair.new] as const) {
      const fingerprint = stableStringify(side);
      const seen = seenRunRefs.get(side.runRef);
      if (seen !== undefined && seen !== fingerprint) {
        return decide(
          context,
          "rejected",
          "rejected_duplicate_run",
          "Rejected: a run ref carries conflicting content.",
          counts,
        );
      }
      if (seen !== undefined) {
        return decide(
          context,
          "rejected",
          "rejected_duplicate_run",
          "Rejected: a duplicate run ref is present.",
          counts,
        );
      }
      seenRunRefs.set(side.runRef, fingerprint);
      if (seenContexts.has(side.contextId)) {
        return decide(
          context,
          "rejected",
          "rejected_shared_context",
          "Rejected: a context is reused across evaluated runs.",
          counts,
        );
      }
      seenContexts.add(side.contextId);
    }
    // Fixed fixture + model/config/sample per class: both sides share the
    // fixture and the root config digest.
    if (
      pair.old.fixtureId !== pair.new.fixtureId ||
      pair.old.fixtureHash !== pair.new.fixtureHash ||
      pair.old.configDigest !== context.configDigest ||
      pair.new.configDigest !== context.configDigest
    ) {
      return decide(
        context,
        "rejected",
        "rejected_binding_drift",
        "Rejected: a pair drifts across fixture, hash, or config identity.",
        counts,
      );
    }
    // Fixed fixture identity is id + hash + config, not id alone: changing
    // the hash on both sides is a different fixture, not a repeat sample.
    const fixtureIdentity = `${pair.old.fixtureId}|${pair.old.fixtureHash}|${pair.old.configDigest}`;
    const fixed = fixtureByClass.get(pair.fixtureClass);
    if (fixed !== undefined && fixed !== fixtureIdentity) {
      return decide(
        context,
        "rejected",
        "rejected_binding_drift",
        "Rejected: a fixture class reuses no fixed fixture.",
        counts,
      );
    }
    fixtureByClass.set(pair.fixtureClass, fixtureIdentity);
    // Observed skill hash must match the verified isolated snapshot each side.
    if (
      pair.old.observedSkillSha256 !== context.oldSnapshotDigest ||
      pair.new.observedSkillSha256 !== context.newSnapshotDigest
    ) {
      return decide(
        context,
        "rejected",
        "rejected_snapshot_mismatch",
        "Rejected: an observed skill hash does not match its verified snapshot.",
        counts,
      );
    }
    // Independently complete per-run telemetry; unknowns never promote.
    for (const side of [pair.old, pair.new] as const) {
      if (side.completionQuality === "unknown") {
        return decide(
          context,
          "hold",
          "hold_unknown_telemetry",
          "Held: run telemetry is independently incomplete.",
          counts,
        );
      }
    }
  }

  // A self-asserted worker pass can never manufacture a trusted receipt:
  // when trusted pairs show no candidate pass, the claim is forged.
  const trustedNewPass = context.pairs.some((pair) => pair.new.outcome === "pass");
  if (candidate.claimedPass === true && trustedNewPass === false && context.pairs.length > 0) {
    return decide(
      context,
      "rejected",
      "rejected_forged_receipt",
      "Rejected: a worker pass claim cannot manufacture a trusted receipt.",
      counts,
    );
  }

  const byClass = (fixtureClass: SkillEvaluationFixtureClass): Array<SkillEvaluationTrustedPair> =>
    context.pairs.filter((pair) => pair.fixtureClass === fixtureClass);
  const classes: Record<SkillEvaluationFixtureClass, Array<SkillEvaluationTrustedPair>> = {
    failure: byClass("failure"),
    positive: byClass("positive"),
    negative: byClass("negative"),
  };
  for (const fixtureClass of SKILL_EVALUATION_FIXTURE_CLASSES) {
    const observed = classes[fixtureClass];
    counts[fixtureClass] = {
      required,
      observed: observed.length,
      oldPass: observed.filter((pair) => pair.old.outcome === "pass").length,
      newPass: observed.filter((pair) => pair.new.outcome === "pass").length,
    };
  }

  // Every class needs coverage; missing negatives never become review_ready.
  for (const fixtureClass of SKILL_EVALUATION_FIXTURE_CLASSES) {
    if (classes[fixtureClass].length === 0) {
      return decide(
        context,
        "hold",
        "hold_missing_class",
        "Held: a fixture class has no trusted pair.",
        counts,
      );
    }
  }
  // Stochastic runs honor the explicit root-required repeat count.
  for (const fixtureClass of SKILL_EVALUATION_FIXTURE_CLASSES) {
    if (classes[fixtureClass].length < required) {
      return decide(
        context,
        "hold",
        "hold_insufficient_samples",
        "Held: a fixture class does not cover the required samples.",
        counts,
      );
    }
  }

  // Regression checks shared by the fix path and the identical-snapshot
  // path: positive failures, negative false-triggers, added unnecessary
  // loads/lookups, and degraded completion on the new side. No arbitrary
  // performance threshold or invented gain percentage is applied: any
  // increase counts.
  const regressionDecision = (): SkillEvaluationReconciliationResult | null => {
    const positiveNewFail = classes.positive.filter((pair) => pair.new.outcome === "fail").length;
    if (positiveNewFail > 0) {
      return decide(
        context,
        "rejected",
        "rejected_regression",
        "Rejected: the candidate regresses the normal positive case.",
        counts,
      );
    }
    if (counts.positive.oldPass < classes.positive.length) {
      return decide(
        context,
        "hold",
        "hold_unstable_samples",
        "Held: mixed positive-fixture samples report instability.",
        counts,
      );
    }
    // A positive fixture must actually demonstrate successful skill
    // trigger/application on both sides, not only an outcome pass.
    for (const pair of classes.positive) {
      if (pair.old.skillTriggered !== true || pair.new.skillTriggered !== true) {
        return decide(
          context,
          "hold",
          "hold_unstable_samples",
          "Held: the positive fixture does not demonstrate skill application.",
          counts,
        );
      }
    }
    for (const pair of classes.negative) {
      if (pair.old.outcome !== "pass" || pair.new.outcome !== "pass") {
        if (pair.new.outcome === "fail") {
          return decide(
            context,
            "rejected",
            "rejected_false_trigger",
            "Rejected: the candidate false-triggers the negative case.",
            counts,
          );
        }
        return decide(
          context,
          "hold",
          "hold_unstable_samples",
          "Held: mixed negative-fixture samples report instability.",
          counts,
        );
      }
      // Negative must actually be non-trigger on the candidate side; a
      // baseline that already triggers is not a clean non-trigger fixture.
      if (pair.new.skillTriggered === true) {
        return decide(
          context,
          "rejected",
          "rejected_false_trigger",
          "Rejected: the candidate triggers on the negative case.",
          counts,
        );
      }
      if (pair.old.skillTriggered === true) {
        return decide(
          context,
          "hold",
          "hold_unstable_samples",
          "Held: the negative baseline is not a clean non-trigger.",
          counts,
        );
      }
    }
    for (const pair of [...classes.positive, ...classes.negative]) {
      if (
        pair.new.unnecessaryLoads > pair.old.unnecessaryLoads ||
        pair.new.repeatedLookups > pair.old.repeatedLookups
      ) {
        return decide(
          context,
          "rejected",
          "rejected_load_regression",
          "Rejected: the candidate adds unnecessary loads or lookups without fix quality.",
          counts,
        );
      }
    }
    // Degraded completion on any class (including the failure fix) cannot
    // be queued as quality-verified from a pass boolean alone.
    for (const pair of [...classes.failure, ...classes.positive, ...classes.negative]) {
      if (pair.old.completionQuality === "ok" && pair.new.completionQuality === "degraded") {
        return decide(
          context,
          "rejected",
          "rejected_regression",
          "Rejected: the candidate degrades completion quality.",
          counts,
        );
      }
      if (pair.new.completionQuality === "degraded") {
        return decide(
          context,
          "hold",
          "hold_unknown_telemetry",
          "Held: candidate completion quality is degraded.",
          counts,
        );
      }
    }
    return null;
  };

  // Identical snapshots carry no fix to demonstrate: regressions still
  // reject, any failing side holds as flaky evidence, and clean all-pass
  // evidence describes no change.
  if (context.oldSnapshotDigest === context.newSnapshotDigest) {
    const regression = regressionDecision();
    if (regression !== null) return regression;
    const allPass = context.pairs.every((pair) => pair.old.outcome === "pass" && pair.new.outcome === "pass");
    if (allPass) {
      return decide(
        context,
        "no_change",
        "no_change_identical",
        "No change: identical snapshots with clean replay evidence.",
        counts,
      );
    }
    return decide(
      context,
      "hold",
      "hold_unstable_samples",
      "Held: identical snapshots with mixed outcomes report instability.",
      counts,
    );
  }

  // Behavior expectations for the failure fixture; mixed stochastic samples
  // hold as unstable.
  const failureOldFail = classes.failure.filter((pair) => pair.old.outcome === "fail").length;
  const failureNewPass = counts.failure.newPass;
  if (failureOldFail < classes.failure.length) {
    return decide(
      context,
      "hold",
      "hold_no_failure_reproduced",
      "Held: the original failure is not reproduced on the baseline.",
      counts,
    );
  }
  if (failureNewPass < classes.failure.length) {
    return decide(
      context,
      "hold",
      failureNewPass === 0 ? "hold_no_improvement" : "hold_unstable_samples",
      failureNewPass === 0
        ? "Held: the candidate shows no improvement on the failure fixture."
        : "Held: mixed failure-fixture samples report instability.",
      counts,
    );
  }
  const regression = regressionDecision();
  if (regression !== null) return regression;
  return decide(
    context,
    "review_ready",
    "ready_fix_verified",
    "Ready: the fix is verified on matched clean independent 3-class replay.",
    counts,
  );
};
