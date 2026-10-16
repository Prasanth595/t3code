// Pure P1 mission result reconciliation: decide what a terminal delegated
// child result (or a mailbox ACK, review, acceptance, integration, or
// installed-delivery receipt) means for one mission task's result record.
//
// The canonical mission caller owns persistence: it supplies the current
// record, persists the returned one alongside existing mission events, and
// routes the current role later. This module performs no I/O, registry,
// database, scheduler, fanout, probe, or retro-callback work of any kind.
//
// Contract: accepted source -> integrated -> separately installed exact
// build delivery. Source acceptance and git integration never require, and
// never claim, installed delivery; installed delivery is its own receipt.
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  defaultMissionResultEvidencePolicy,
  MAX_QUARANTINE_ENTRIES,
  type MissionResultArrival,
  type MissionResultDecision,
  type MissionResultDigests,
  type MissionResultDisposition,
  type MissionResultEvidencePolicy,
  type MissionResultProvenance,
  type MissionResultQuarantineEntry,
  type MissionResultReceipt,
  type MissionResultRecord,
  type MissionResultServerObservation,
  type MissionResultState,
} from "../../../../packages/contracts/src/missionResult.ts";

/**
 * Leaf schemas and types live in contracts (`missionResult.ts`) and are
 * re-exported here so existing importers keep working. This module keeps
 * only the pure runtime policy functions.
 */
export * from "../../../../packages/contracts/src/missionResult.ts";

const digestsEqual = (l: MissionResultDigests, r: MissionResultDigests): boolean =>
  l.inputDigest === r.inputDigest &&
  l.dependencyDigest === r.dependencyDigest &&
  l.acceptanceDigest === r.acceptanceDigest;

const sameCommitSet = (l: ReadonlyArray<string>, r: ReadonlyArray<string>): boolean =>
  l.length === r.length && [...l].sort().every((c, i) => c === [...r].sort()[i]);
const sameList = (l: ReadonlyArray<string>, r: ReadonlyArray<string>): boolean =>
  l.length === r.length && l.every((v, i) => v === r[i]);

/** Canonical requirement (from the record) checked against the arrival's actual chain. */
const ancestrySatisfied = (
  canonicalRequired: ReadonlyArray<string>,
  arrival: MissionResultProvenance,
): boolean =>
  canonicalRequired.every(
    (req) => arrival.ancestry.includes(req) || arrival.commitSet.includes(req),
  );

const provenanceExactEqual = (l: MissionResultProvenance, r: MissionResultProvenance): boolean =>
  l.childTaskId === r.childTaskId &&
  l.childThreadId === r.childThreadId &&
  l.childRunId === r.childRunId &&
  sameCommitSet(l.commitSet, r.commitSet) &&
  l.worktreeRef === r.worktreeRef &&
  sameList(l.requiredAncestry, r.requiredAncestry) &&
  sameList(l.ancestry, r.ancestry) &&
  l.source === r.source &&
  l.sourceRef === r.sourceRef &&
  l.resultRevision === r.resultRevision;

export class MissionResultReconciliationError extends Schema.TaggedError<MissionResultReconciliationError>()(
  "MissionResultReconciliationError",
  {
    operation: Schema.Literals([
      "initialize",
      "arrive",
      "acknowledge",
      "reconstruct",
      "review",
      "accept",
      "integrate",
      "reject",
      "freshness",
      "deliver",
      "observe",
      "installed_delivery",
    ]),
    category: Schema.Literals([
      "stale_attempt",
      "digest_mismatch",
      "pending_children",
      "frozen",
      "cancelled_late",
      "evidence_mismatch",
      "not_installed_delivery",
      "ancestry_unmet",
      "invalid_transition",
      "regression_blocked",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Mission result ${this.operation} failed (${this.category}).`;
  }
}
export type MissionResultReconciliationResult = Result.Result<
  MissionResultDecision,
  MissionResultReconciliationError
>;

const decide = (
  record: MissionResultRecord,
  disposition: MissionResultDisposition,
  detail: string,
): MissionResultReconciliationResult => Result.succeed({ record, disposition, detail });
const refuse = (
  operation: MissionResultReconciliationError["operation"],
  category: MissionResultReconciliationError["category"],
  detail?: string,
): MissionResultReconciliationResult =>
  detail === undefined
    ? Result.fail(new MissionResultReconciliationError({ operation, category }))
    : Result.fail(new MissionResultReconciliationError({ operation, category, detail }));

/** Deduped, bounded quarantine: a repeated incident is never stored twice. */
const quarantine = (
  record: MissionResultRecord,
  entry: MissionResultQuarantineEntry,
): MissionResultRecord => {
  const dup = record.quarantined.some(
    (q) =>
      q.resultRevision === entry.resultRevision &&
      q.summaryText === entry.summaryText &&
      q.reason === entry.reason,
  );
  if (dup) return record;
  const next = [...record.quarantined, entry];
  return {
    ...record,
    quarantined:
      next.length > MAX_QUARANTINE_ENTRIES
        ? next.slice(next.length - MAX_QUARANTINE_ENTRIES)
        : next,
  };
};

const isTerminalRecord = (s: MissionResultState): boolean =>
  s === "accepted" || s === "rejected" || s === "integrated";
const identityMatches = (record: MissionResultRecord, p: MissionResultProvenance): boolean =>
  p.childTaskId === record.provenance.childTaskId &&
  p.childThreadId === record.provenance.childThreadId;
const observationTrusts = (
  record: MissionResultRecord,
  obs: MissionResultServerObservation | undefined,
  runId: string,
): boolean =>
  obs !== undefined &&
  obs.childTaskId === record.provenance.childTaskId &&
  obs.childThreadId === record.provenance.childThreadId &&
  obs.childRunId === runId &&
  obs.resultRevision >= record.provenance.resultRevision;

/** Gate shared by review/accept/integrate/installed: no promotion while pending, frozen, or not completed. */
const promotionBlock = (
  record: MissionResultRecord,
  op: MissionResultReconciliationError["operation"],
): MissionResultReconciliationResult | null => {
  if (record.pendingChildRuns)
    return refuse(op, "pending_children", "Child runs are still pending.");
  if (
    record.cancellationRequested ||
    record.outcome === "cancelled" ||
    record.outcome === "interrupted" ||
    record.outcome === "uncertain"
  )
    return refuse(op, "frozen", "A frozen or uncertain result cannot be promoted.");
  if (record.outcome !== "completed")
    return refuse(
      op,
      "invalid_transition",
      "Only a completed result can be promoted; a failed result is never promoted.",
    );
  return null;
};

/**
 * Reconcile one terminal arrival. Identity, canonical ancestry, and pending
 * state are all bound to the durable record; an arrival cannot declare its
 * own required ancestry, clear its own pending flag, or invent a producing
 * run/revision to supersede the recorded result.
 */
export const reconcileTerminalArrival = (input: {
  readonly record: MissionResultRecord;
  readonly arrival: MissionResultArrival;
  readonly serverObservation?: MissionResultServerObservation;
}): MissionResultReconciliationResult => {
  const { record, arrival } = input;
  const obs = input.serverObservation;
  // Authoritative observation may clear pending only when identity-bound and current/newer.
  const trustedNoPending =
    obs !== undefined && observationTrusts(record, obs, obs.childRunId) && !obs.pendingChildRuns;
  const effectiveRecord: MissionResultRecord =
    trustedNoPending && record.pendingChildRuns ? { ...record, pendingChildRuns: false } : record;
  if ((arrival.pendingChildRuns || effectiveRecord.pendingChildRuns) && !trustedNoPending) {
    return decide(
      record,
      "held_not_done",
      "Child runs are still pending; only a matching authoritative observation can clear this.",
    );
  }
  if (!identityMatches(record, arrival.provenance)) {
    const held = quarantine(effectiveRecord, {
      resultRevision: arrival.provenance.resultRevision,
      summaryText: arrival.summaryText,
      reason: "stale: arrival child task/thread does not match the canonical record identity",
    });
    return decide(held, "held_stale", "The arrival belongs to a different child task or thread.");
  }
  // A new producing run needs trusted server observation of that exact run.
  if (
    arrival.provenance.childRunId !== record.provenance.childRunId &&
    !observationTrusts(record, obs, arrival.provenance.childRunId)
  ) {
    const held = quarantine(effectiveRecord, {
      resultRevision: arrival.provenance.resultRevision,
      summaryText: arrival.summaryText,
      reason: "stale: unknown producing run without server observation",
    });
    return decide(
      held,
      "held_stale",
      "An unknown producing run cannot override the recorded result.",
    );
  }
  if (
    record.cancellationRequested ||
    arrival.cancellationRequested ||
    arrival.outcome === "cancelled" ||
    arrival.outcome === "interrupted" ||
    arrival.outcome === "uncertain"
  ) {
    const frozen = quarantine(effectiveRecord, {
      resultRevision: arrival.provenance.resultRevision,
      summaryText: arrival.summaryText,
      reason: "frozen: cancellation requested or uncertain outcome",
    });
    return decide(
      frozen,
      "held_frozen",
      "Cancellation or an uncertain outcome freezes reconciliation.",
    );
  }
  if (arrival.attemptNumber !== record.attemptNumber) {
    const held = quarantine(effectiveRecord, {
      resultRevision: arrival.provenance.resultRevision,
      summaryText: arrival.summaryText,
      reason: "stale: arrival attempt does not match the current attempt",
    });
    return decide(held, "held_stale", "The arrival belongs to a different attempt.");
  }
  if (!digestsEqual(arrival.digests, record.digests)) {
    const held = quarantine(effectiveRecord, {
      resultRevision: arrival.provenance.resultRevision,
      summaryText: arrival.summaryText,
      reason: "stale: arrival digests do not match the current task digests",
    });
    return decide(held, "held_stale", "The arrival was produced from different task input.");
  }
  if (!ancestrySatisfied(record.provenance.requiredAncestry, arrival.provenance)) {
    return refuse(
      "arrive",
      "ancestry_unmet",
      "The arrival does not descend from the canonical required ancestry.",
    );
  }
  if (isTerminalRecord(record.state)) {
    const kept = quarantine(effectiveRecord, {
      resultRevision: arrival.provenance.resultRevision,
      summaryText: arrival.summaryText,
      reason: "late arrival preserved: terminal record cannot regress",
    });
    return decide(kept, "no_regression", "A terminal record never regresses from a later arrival.");
  }
  if (arrival.provenance.resultRevision < record.provenance.resultRevision) {
    const held = quarantine(effectiveRecord, {
      resultRevision: arrival.provenance.resultRevision,
      summaryText: arrival.summaryText,
      reason: "stale: arrival revision precedes the recorded revision",
    });
    return decide(held, "held_stale", "The arrival is older than the recorded result.");
  }
  if (arrival.provenance.resultRevision === record.provenance.resultRevision) {
    const exact =
      arrival.outcome === record.outcome &&
      arrival.summaryText === record.summaryText &&
      digestsEqual(arrival.digests, record.digests) &&
      provenanceExactEqual(arrival.provenance, record.provenance);
    if (exact)
      return decide(
        effectiveRecord,
        "duplicate",
        "The arrival exactly repeats the recorded result.",
      );
    const held = quarantine(effectiveRecord, {
      resultRevision: arrival.provenance.resultRevision,
      summaryText: arrival.summaryText,
      reason: "conflict: same identity and revision with different content",
    });
    return decide(
      held,
      "held_conflict",
      "Same revision with different content conflicts with the recorded result.",
    );
  }
  // Higher revision supersedes: any prior review/acceptance no longer binds.
  const supersedesReview = record.state === "reviewed" || record.state === "accepted";
  const { reviewReceipt: _r, acceptanceReceipt: _a, ...rest } = effectiveRecord;
  const advanced: MissionResultRecord = {
    ...(supersedesReview ? rest : effectiveRecord),
    state: "observed",
    outcome: arrival.outcome,
    provenance: arrival.provenance,
    summaryText: arrival.summaryText,
    pendingChildRuns: false,
  };
  const kept = supersedesReview
    ? quarantine(advanced, {
        resultRevision: record.provenance.resultRevision,
        summaryText: `Superseded review of revision ${record.provenance.resultRevision} no longer binds the producing revision.`,
        reason: "review superseded: exact producing revision changed",
      })
    : advanced;
  return decide(
    kept,
    "advanced",
    supersedesReview
      ? "A newer matching result supersedes the prior review and returns to observed."
      : "The later terminal result matches the current attempt and input.",
  );
};

/** produced -> delivered. Transport only; not observation, review, or acceptance. */
export const markMissionResultDelivered = (input: {
  readonly record: MissionResultRecord;
}): MissionResultReconciliationResult => {
  if (input.record.state !== "produced")
    return refuse(
      "deliver",
      "invalid_transition",
      "Only a produced result can be marked delivered.",
    );
  return decide({ ...input.record, state: "delivered" }, "advanced", "Result delivered.");
};

/** delivered -> observed (also produced -> observed when delivery was implicit in the server observation). */
export const markMissionResultObserved = (input: {
  readonly record: MissionResultRecord;
}): MissionResultReconciliationResult => {
  if (input.record.state !== "delivered" && input.record.state !== "produced")
    return refuse(
      "observe",
      "invalid_transition",
      "Only a produced or delivered result can be marked observed.",
    );
  return decide(
    { ...input.record, state: "observed" },
    "advanced",
    "Result observed and awaiting review.",
  );
};

/**
 * Consume an authoritative server observation: clears/sets pending only for
 * the canonical identity at a current/newer revision, and optionally drives
 * produced -> delivered -> observed. Foreign or stale observations change nothing.
 */
export const applyServerObservation = (input: {
  readonly record: MissionResultRecord;
  readonly observation: MissionResultServerObservation;
}): MissionResultReconciliationResult => {
  const { record, observation } = input;
  if (!observationTrusts(record, observation, observation.childRunId)) {
    return decide(record, "held_stale", "A foreign or stale server observation changes nothing.");
  }
  let next: MissionResultRecord = { ...record, pendingChildRuns: observation.pendingChildRuns };
  if (observation.stage === "delivered" && next.state === "produced")
    next = { ...next, state: "delivered" };
  if (observation.stage === "observed" && (next.state === "produced" || next.state === "delivered"))
    next = { ...next, state: "observed" };
  return decide(next, "advanced", "Authoritative server observation applied.");
};

/** Mailbox ACK is metadata only: state (including awaiting-review) never moves. */
export const acknowledgeMailboxDelivery = (input: {
  readonly record: MissionResultRecord;
}): MissionResultReconciliationResult => {
  if (input.record.state === "produced")
    return refuse(
      "acknowledge",
      "invalid_transition",
      "Nothing has been delivered yet; there is no delivery to ACK.",
    );
  return decide(
    { ...input.record, mailboxAcked: true },
    "advanced",
    "Mailbox delivery acknowledged (ACK-only metadata); review state unchanged.",
  );
};

/**
 * Validation after restart, not a runtime restart: re-validates/returns the
 * durable record unchanged. Observed stays awaiting review.
 */
export const validateRecordAfterRestart = (input: {
  readonly record: MissionResultRecord;
}): MissionResultReconciliationResult =>
  decide(
    input.record,
    "duplicate",
    "Validation after restart preserves the durable record; this is not a runtime restart.",
  );
/** Backward-compatible name; validation only, not full restart reconstruction. */
export const reconstructAfterRestart = validateRecordAfterRestart;

const receiptBindsProvenance = (
  receipt: MissionResultReceipt,
  p: MissionResultProvenance,
): boolean =>
  receipt.revision === p.resultRevision && sameCommitSet(receipt.commitSet, p.commitSet);

export const reviewMissionResult = (input: {
  readonly record: MissionResultRecord;
  readonly receipt: MissionResultReceipt;
}): MissionResultReconciliationResult => {
  const { record, receipt } = input;
  if (record.state !== "observed")
    return refuse("review", "invalid_transition", "Only an observed result can be reviewed.");
  if (record.pendingChildRuns)
    return refuse("review", "pending_children", "Child runs are still pending.");
  if (record.cancellationRequested)
    return refuse("review", "frozen", "A frozen result cannot be reviewed.");
  if (receipt.kind !== "review")
    return refuse("review", "evidence_mismatch", "A review requires a review receipt.");
  if (!receiptBindsProvenance(receipt, record.provenance))
    return refuse(
      "review",
      "evidence_mismatch",
      "The review receipt must bind the exact producing revision and commit set.",
    );
  return decide(
    { ...record, state: "reviewed", reviewReceipt: receipt },
    "advanced",
    "Result reviewed against the exact producing revision.",
  );
};

/** Source acceptance: reviewed + completed + caller policy evidence. Installed delivery is NOT required. */
export const acceptMissionResult = (input: {
  readonly record: MissionResultRecord;
  readonly receipt: MissionResultReceipt;
  readonly evidencePolicy?: MissionResultEvidencePolicy;
}): MissionResultReconciliationResult => {
  const { record, receipt } = input;
  const policy = input.evidencePolicy ?? defaultMissionResultEvidencePolicy;
  if (record.state !== "reviewed")
    return refuse("accept", "invalid_transition", "Only a reviewed result can be accepted.");
  const blocked = promotionBlock(record, "accept");
  if (blocked) return blocked;
  if (receipt.kind !== "acceptance")
    return refuse("accept", "evidence_mismatch", "Acceptance requires an acceptance receipt.");
  if (!record.reviewReceipt || !receiptBindsProvenance(record.reviewReceipt, record.provenance))
    return refuse(
      "accept",
      "evidence_mismatch",
      "The existing review does not bind the current producing revision and commit set.",
    );
  if (!receiptBindsProvenance(receipt, record.provenance))
    return refuse(
      "accept",
      "evidence_mismatch",
      "The acceptance receipt must bind the exact producing revision and commit set.",
    );
  if (!policy.acceptanceEvidenceKinds.includes(receipt.evidenceKind))
    return refuse(
      "accept",
      "evidence_mismatch",
      "The acceptance evidence does not satisfy the caller evidence policy.",
    );
  return decide(
    { ...record, state: "accepted", acceptanceReceipt: receipt },
    "advanced",
    "Source result accepted under the caller evidence policy; installed delivery not required.",
  );
};

/** Git/source integration of an accepted result. Installed delivery is NOT required and never claimed here. */
export const integrateMissionResult = (input: {
  readonly record: MissionResultRecord;
  readonly receipt: MissionResultReceipt;
  readonly evidencePolicy?: MissionResultEvidencePolicy;
}): MissionResultReconciliationResult => {
  const { record, receipt } = input;
  const policy = input.evidencePolicy ?? defaultMissionResultEvidencePolicy;
  if (record.state !== "accepted")
    return refuse("integrate", "invalid_transition", "Only an accepted result can be integrated.");
  if (record.provenance.commitSet.length === 0)
    return refuse("integrate", "evidence_mismatch", "Git integration requires a producing commit.");
  const blocked = promotionBlock(record, "integrate");
  if (blocked) return blocked;
  if (receipt.kind !== "integration")
    return refuse("integrate", "evidence_mismatch", "Integration requires an integration receipt.");
  if (!receiptBindsProvenance(receipt, record.provenance))
    return refuse(
      "integrate",
      "evidence_mismatch",
      "The integration receipt must bind the exact producing revision and commit set.",
    );
  if (!policy.integrationEvidenceKinds.includes(receipt.evidenceKind))
    return refuse(
      "integrate",
      "evidence_mismatch",
      "The integration evidence does not satisfy the caller evidence policy.",
    );
  return decide(
    { ...record, state: "integrated", integrationReceipt: receipt },
    "advanced",
    "Source result integrated; installed delivery remains a separate step.",
  );
};

/**
 * Separate installed exact-build delivery: only after integration, only an
 * installed_delivery receipt binding the exact revision/commit set and, when
 * the caller knows it, the exact expected build ref. Test/check/merge-back
 * receipts can never satisfy this.
 */
export const recordInstalledDelivery = (input: {
  readonly record: MissionResultRecord;
  readonly receipt: MissionResultReceipt;
  readonly evidencePolicy?: MissionResultEvidencePolicy;
  readonly expectedBuildRef?: string;
}): MissionResultReconciliationResult => {
  const { record, receipt } = input;
  if (record.state !== "integrated")
    return refuse(
      "installed_delivery",
      "invalid_transition",
      "Installed delivery requires an integrated result first.",
    );
  const blocked = promotionBlock(record, "installed_delivery");
  if (blocked) return blocked;
  if (receipt.kind !== "installed_delivery" || receipt.evidenceKind !== "installed_delivery")
    return refuse(
      "installed_delivery",
      "not_installed_delivery",
      "Only installed-delivery evidence records installed delivery.",
    );
  if (!receiptBindsProvenance(receipt, record.provenance))
    return refuse(
      "installed_delivery",
      "evidence_mismatch",
      "Installed delivery must bind the exact producing revision and commit set.",
    );
  const expected = input.expectedBuildRef ?? input.evidencePolicy?.installedBuildRef;
  if (!expected || receipt.evidenceRef !== expected)
    return refuse(
      "installed_delivery",
      "evidence_mismatch",
      "Installed delivery build does not match the expected exact build.",
    );
  return decide(
    { ...record, installedDeliveryReceipt: receipt },
    "advanced",
    "Installed exact-build delivery recorded separately from source integration.",
  );
};

export const rejectMissionResult = (input: {
  readonly record: MissionResultRecord;
  readonly reason: string;
}): MissionResultReconciliationResult => {
  const { record } = input;
  if (record.state !== "observed" && record.state !== "reviewed")
    return refuse(
      "reject",
      "invalid_transition",
      "Only an observed or reviewed result can be rejected.",
    );
  const rejected: MissionResultRecord = quarantine(
    { ...record, state: "rejected" },
    {
      resultRevision: record.provenance.resultRevision,
      summaryText: input.reason,
      reason: "rejection reason",
    },
  );
  return decide(rejected, "advanced", "Result rejected.");
};

export const checkAcceptanceFreshness = (input: {
  readonly record: MissionResultRecord;
  readonly currentDigests: MissionResultDigests;
}): MissionResultReconciliationResult => {
  const { record, currentDigests } = input;
  if (record.state !== "accepted" && record.state !== "integrated")
    return decide(
      record,
      "duplicate",
      "Only accepted or integrated records carry acceptance to invalidate.",
    );
  if (digestsEqual(currentDigests, record.digests))
    return decide(record, "duplicate", "Unrelated changes leave acceptance intact.");
  if (record.state === "integrated")
    return decide(
      record,
      "duplicate",
      "Historical integration is preserved; changed input does not rewrite it.",
    );
  const { acceptanceReceipt: _x, reviewReceipt: _y, ...unaccepted } = record;
  const invalidated: MissionResultRecord = quarantine(
    { ...unaccepted, state: "observed", digests: currentDigests },
    {
      resultRevision: record.provenance.resultRevision,
      summaryText: `Acceptance of revision ${record.provenance.resultRevision} invalidated by changed task input.`,
      reason: "acceptance invalidated: relevant spec changed",
    },
  );
  return decide(invalidated, "invalidated", "Changed task input invalidates acceptance.");
};
