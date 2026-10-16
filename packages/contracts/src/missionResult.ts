import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Leaf wire schemas for one mission task's result record.
 *
 * Extracted verbatim from the server's pure result-reconciliation module so
 * contracts stay the single schema owner. This module is a leaf: schemas,
 * derived types, and small bound constants only. It imports base schemas
 * directly, performs no I/O, and holds no runtime policy logic — promotion,
 * quarantine, and supersession decisions live in the server's
 * `MissionResultReconciliation.ts`, which re-exports these schemas for
 * backward compatibility.
 */

const atMost =
  (limit: number) =>
  (values: ReadonlyArray<unknown>): boolean =>
    values.length <= limit;
export const MissionResultCommitSet = Schema.Array(TrimmedNonEmptyString).check(
  Schema.makeFilter(atMost(64), {
    expected: "at most sixty-four commits; scratch results may have none",
  }),
);
export type MissionResultCommitSet = typeof MissionResultCommitSet.Type;

export const MissionResultAncestry = Schema.Array(TrimmedNonEmptyString).check(
  Schema.makeFilter(atMost(128), { expected: "at most one hundred twenty-eight ancestry commits" }),
);
export type MissionResultAncestry = typeof MissionResultAncestry.Type;

export const MissionResultState = Schema.Literals([
  "produced",
  "delivered",
  "observed",
  "reviewed",
  "accepted",
  "rejected",
  "integrated",
]);
export type MissionResultState = typeof MissionResultState.Type;

export const MissionResultOutcome = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "uncertain",
]);
export type MissionResultOutcome = typeof MissionResultOutcome.Type;

export const MissionResultDigests = Schema.Struct({
  inputDigest: TrimmedNonEmptyString,
  dependencyDigest: TrimmedNonEmptyString,
  acceptanceDigest: TrimmedNonEmptyString,
});
export type MissionResultDigests = typeof MissionResultDigests.Type;

/**
 * Exact producing identity. The canonical record's childTaskId/childThreadId
 * (and its requiredAncestry) are the expected identity: an arrival is bound
 * to them, never the other way round. Its own declared requiredAncestry is
 * untrusted and ignored.
 */
export const MissionResultProvenance = Schema.Struct({
  childTaskId: TrimmedNonEmptyString,
  childThreadId: TrimmedNonEmptyString,
  childRunId: TrimmedNonEmptyString,
  commitSet: MissionResultCommitSet,
  worktreeRef: Schema.optional(TrimmedNonEmptyString),
  requiredAncestry: MissionResultAncestry,
  ancestry: MissionResultAncestry,
  source: TrimmedNonEmptyString,
  sourceRef: TrimmedNonEmptyString,
  resultRevision: NonNegativeInt,
});
export type MissionResultProvenance = typeof MissionResultProvenance.Type;

export const MissionResultEvidenceKind = Schema.Literals([
  "installed_delivery",
  "test_report",
  "check_pass",
  "git_integration",
  "merge_back",
  "other",
]);
export type MissionResultEvidenceKind = typeof MissionResultEvidenceKind.Type;

export const MissionResultReceipt = Schema.Struct({
  kind: Schema.Literals(["review", "acceptance", "integration", "installed_delivery"]),
  revision: NonNegativeInt,
  commitSet: MissionResultCommitSet,
  evidenceKind: MissionResultEvidenceKind,
  evidenceRef: TrimmedNonEmptyString,
  decidedBy: TrimmedNonEmptyString,
  decidedAt: TrimmedNonEmptyString,
});
export type MissionResultReceipt = typeof MissionResultReceipt.Type;

/** Caller-owned canonical criteria: what evidence each stage requires. */
export interface MissionResultEvidencePolicy {
  readonly acceptanceEvidenceKinds: ReadonlyArray<MissionResultEvidenceKind>;
  readonly integrationEvidenceKinds: ReadonlyArray<MissionResultEvidenceKind>;
  /** Installed delivery requires an independently known exact build reference. */
  readonly installedBuildRef?: string;
}
export const defaultMissionResultEvidencePolicy: MissionResultEvidencePolicy = {
  acceptanceEvidenceKinds: ["test_report", "check_pass"],
  integrationEvidenceKinds: ["git_integration"],
};

export const MissionResultQuarantineEntry = Schema.Struct({
  resultRevision: NonNegativeInt,
  summaryText: TrimmedNonEmptyString,
  reason: TrimmedNonEmptyString,
});
export type MissionResultQuarantineEntry = typeof MissionResultQuarantineEntry.Type;

/** Maximum retained quarantine entries per result record. Decode rejects more. */
export const MAX_QUARANTINE_ENTRIES = 32;

export const MissionResultRecord = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  attemptNumber: NonNegativeInt,
  state: MissionResultState,
  outcome: MissionResultOutcome,
  digests: MissionResultDigests,
  provenance: MissionResultProvenance,
  summaryText: TrimmedNonEmptyString,
  cancellationRequested: Schema.Boolean,
  pendingChildRuns: Schema.Boolean,
  mailboxAcked: Schema.Boolean,
  reviewReceipt: Schema.optional(MissionResultReceipt),
  acceptanceReceipt: Schema.optional(MissionResultReceipt),
  integrationReceipt: Schema.optional(MissionResultReceipt),
  installedDeliveryReceipt: Schema.optional(MissionResultReceipt),
  /** Bounded dedup evidence: quarantine never silently drops the canonical result. */
  quarantined: Schema.Array(MissionResultQuarantineEntry).check(
    Schema.makeFilter(atMost(MAX_QUARANTINE_ENTRIES), {
      expected: `at most ${MAX_QUARANTINE_ENTRIES} quarantined entries`,
    }),
  ),
});
export type MissionResultRecord = typeof MissionResultRecord.Type;

export const MissionResultArrival = Schema.Struct({
  attemptNumber: NonNegativeInt,
  outcome: MissionResultOutcome,
  summaryText: TrimmedNonEmptyString,
  digests: MissionResultDigests,
  provenance: MissionResultProvenance,
  pendingChildRuns: Schema.Boolean,
  cancellationRequested: Schema.Boolean,
});
export type MissionResultArrival = typeof MissionResultArrival.Type;

/**
 * Authoritative server observation of a producing run. It is the only input
 * that may clear pendingChildRuns or introduce a new producing run within
 * the canonical child thread; arrivals alone can do neither.
 */
export const MissionResultServerObservation = Schema.Struct({
  childTaskId: TrimmedNonEmptyString,
  childThreadId: TrimmedNonEmptyString,
  childRunId: TrimmedNonEmptyString,
  resultRevision: NonNegativeInt,
  pendingChildRuns: Schema.Boolean,
  stage: Schema.optional(Schema.Literals(["delivered", "observed"])),
});
export type MissionResultServerObservation = typeof MissionResultServerObservation.Type;

export const MissionResultDisposition = Schema.Literals([
  "advanced",
  "held_not_done",
  "held_frozen",
  "held_stale",
  "held_conflict",
  "duplicate",
  "no_regression",
  "invalidated",
]);
export type MissionResultDisposition = typeof MissionResultDisposition.Type;

export const MissionResultDecision = Schema.Struct({
  record: MissionResultRecord,
  disposition: MissionResultDisposition,
  detail: TrimmedNonEmptyString,
});
export type MissionResultDecision = typeof MissionResultDecision.Type;
