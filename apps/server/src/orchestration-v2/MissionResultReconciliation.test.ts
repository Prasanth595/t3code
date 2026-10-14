import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import {
  acceptMissionResult,
  acknowledgeMailboxDelivery,
  applyServerObservation,
  checkAcceptanceFreshness,
  integrateMissionResult,
  markMissionResultDelivered,
  markMissionResultObserved,
  recordInstalledDelivery,
  reconstructAfterRestart,
  reconcileTerminalArrival,
  reviewMissionResult,
  validateRecordAfterRestart,
  type MissionResultArrival,
  type MissionResultDecision,
  type MissionResultReconciliationResult,
  type MissionResultRecord,
  type MissionResultReceipt,
} from "./MissionResultReconciliation.ts";

const S = (r: MissionResultReconciliationResult): MissionResultDecision => {
  if (Result.isFailure(r)) throw new Error("expected success");
  return r.success;
};
const F = (r: MissionResultReconciliationResult) => {
  if (Result.isSuccess(r)) throw new Error("expected failure");
  return r.failure;
};
const digests = {
  inputDigest: "input:abc",
  dependencyDigest: "deps:def",
  acceptanceDigest: "accept:ghi",
};
const provenanceFor = (o: Partial<MissionResultArrival["provenance"]> = {}) => ({
  childTaskId: "mission-task:one",
  childThreadId: "thread:child-one",
  childRunId: "run:child-one-3",
  commitSet: ["commit:aaa", "commit:bbb"],
  worktreeRef: "worktree:child-one",
  requiredAncestry: ["commit:base"],
  ancestry: ["commit:base", "commit:aaa", "commit:bbb"],
  source: "subagent-run",
  sourceRef: "run:child-one-3",
  resultRevision: 3,
  ...o,
});
const recordFor = (o: Partial<MissionResultRecord> = {}): MissionResultRecord => ({
  taskId: "mission-task:one",
  attemptNumber: 2,
  state: "produced",
  outcome: "failed",
  digests,
  provenance: provenanceFor(),
  summaryText: "Original attempt failed: worker hit a scope error.",
  cancellationRequested: false,
  pendingChildRuns: false,
  mailboxAcked: false,
  quarantined: [],
  ...o,
});
const arrivalFor = (o: Partial<MissionResultArrival> = {}): MissionResultArrival => ({
  attemptNumber: 2,
  outcome: "completed",
  summaryText: "Fresh terminal result: worker finished the task.",
  digests,
  provenance: provenanceFor({ resultRevision: 4 }),
  pendingChildRuns: false,
  cancellationRequested: false,
  ...o,
});
const receipt = (o: Partial<MissionResultReceipt>): MissionResultReceipt => ({
  kind: "review",
  revision: 3,
  commitSet: ["commit:aaa", "commit:bbb"],
  evidenceKind: "test_report",
  evidenceRef: "evidence:1",
  decidedBy: "decider:one",
  decidedAt: "2026-10-14T00:00:00.000Z",
  ...o,
});
const observedRecord = () =>
  recordFor({ state: "observed", outcome: "completed", summaryText: "Done." });
const reviewedRecord = (): MissionResultRecord => {
  const r = reviewMissionResult({ record: observedRecord(), receipt: receipt({}) });
  assert.isTrue(Result.isSuccess(r));
  return S(r).record;
};
const acceptedRecord = (): MissionResultRecord => {
  const r = acceptMissionResult({
    record: reviewedRecord(),
    receipt: receipt({
      kind: "acceptance",
      evidenceKind: "check_pass",
      evidenceRef: "checks:green",
    }),
  });
  assert.isTrue(Result.isSuccess(r));
  return S(r).record;
};
const integratedRecord = (): MissionResultRecord => {
  const r = integrateMissionResult({
    record: acceptedRecord(),
    receipt: receipt({
      kind: "integration",
      evidenceKind: "git_integration",
      evidenceRef: "git-commit:1",
    }),
  });
  assert.isTrue(Result.isSuccess(r));
  return S(r).record;
};
const obsFor = (o: Record<string, unknown> = {}) =>
  ({
    childTaskId: "mission-task:one",
    childThreadId: "thread:child-one",
    childRunId: "run:child-one-3",
    resultRevision: 3,
    pendingChildRuns: false,
    ...o,
  }) as never;

describe("MissionResultReconciliation", () => {
  it("keeps context merge-back and unknown installed builds from passing delivery gates", () => {
    const context = integrateMissionResult({
      record: acceptedRecord(),
      receipt: receipt({ kind: "integration", evidenceKind: "merge_back" }),
    });
    assert.isTrue(Result.isFailure(context));
    const unknownBuild = recordInstalledDelivery({
      record: integratedRecord(),
      receipt: receipt({ kind: "installed_delivery", evidenceKind: "installed_delivery" }),
    });
    assert.isTrue(Result.isFailure(unknownBuild));
  });
  it("foreign thread/task with same attempt, digests and newer revision is held, not advanced (Spark regression)", () => {
    const d = reconcileTerminalArrival({
      record: recordFor(),
      arrival: arrivalFor({
        provenance: provenanceFor({
          childThreadId: "foreign-thread",
          childTaskId: "foreign-task",
          childRunId: "run:foreign",
          resultRevision: 9,
        }),
      }),
    });
    assert.isTrue(Result.isSuccess(d));
    assert.strictEqual(S(d).disposition, "held_stale");
    assert.strictEqual(
      S(d).record.summaryText,
      "Original attempt failed: worker hit a scope error.",
    );
    assert.strictEqual(S(d).record.quarantined.length, 1);
  });
  it("attacker empty self-declared requiredAncestry cannot omit canonical ancestry", () => {
    const d = reconcileTerminalArrival({
      record: recordFor(),
      arrival: arrivalFor({
        provenance: provenanceFor({
          requiredAncestry: [],
          ancestry: ["commit:unrelated"],
          resultRevision: 4,
        }),
      }),
    });
    assert.isTrue(Result.isFailure(d));
    assert.strictEqual(F(d).category, "ancestry_unmet");
  });
  it("same revision with different commit set or source conflicts; exact duplicate dedups", () => {
    const rec = recordFor({ state: "observed", outcome: "completed", summaryText: "Done." });
    const diffCommit = reconcileTerminalArrival({
      record: rec,
      arrival: arrivalFor({
        summaryText: "Done.",
        provenance: provenanceFor({ resultRevision: 3, commitSet: ["commit:zzz"] }),
      }),
    });
    assert.isTrue(Result.isSuccess(diffCommit));
    assert.strictEqual(S(diffCommit).disposition, "held_conflict");
    assert.deepStrictEqual(S(diffCommit).record.provenance.commitSet, ["commit:aaa", "commit:bbb"]);
    const diffSource = reconcileTerminalArrival({
      record: rec,
      arrival: arrivalFor({
        summaryText: "Done.",
        provenance: provenanceFor({ resultRevision: 3, source: "other", sourceRef: "x" }),
      }),
    });
    assert.isTrue(Result.isSuccess(diffSource));
    assert.strictEqual(S(diffSource).disposition, "held_conflict");
    const exact = reconcileTerminalArrival({
      record: rec,
      arrival: arrivalFor({
        summaryText: "Done.",
        provenance: provenanceFor({ resultRevision: 3 }),
      }),
    });
    assert.isTrue(Result.isSuccess(exact));
    assert.strictEqual(S(exact).disposition, "duplicate");
    assert.strictEqual(S(exact).record.quarantined.length, 0);
  });
  it("reviewed commit supersession by higher revision returns observed unreviewed", () => {
    const d = reconcileTerminalArrival({
      record: reviewedRecord(),
      arrival: arrivalFor({
        provenance: provenanceFor({
          resultRevision: 4,
          commitSet: ["commit:aaa", "commit:ccc"],
          ancestry: ["commit:base", "commit:aaa", "commit:ccc"],
        }),
      }),
    });
    assert.isTrue(Result.isSuccess(d));
    assert.strictEqual(S(d).record.state, "observed");
    assert.isUndefined(S(d).record.reviewReceipt);
  });
  it("pending true clears only on matching newer authoritative observation, not stale/foreign arrival", () => {
    const pending = recordFor({ pendingChildRuns: true });
    const stale = reconcileTerminalArrival({
      record: pending,
      arrival: arrivalFor(),
      serverObservation: obsFor({ childThreadId: "foreign-thread", childRunId: "run:foreign" }),
    });
    assert.isTrue(Result.isSuccess(stale));
    assert.strictEqual(S(stale).disposition, "held_not_done");
    assert.isTrue(S(stale).record.pendingChildRuns);
    const oldObs = reconcileTerminalArrival({
      record: pending,
      arrival: arrivalFor(),
      serverObservation: obsFor({ resultRevision: 1 }),
    });
    assert.isTrue(Result.isSuccess(oldObs));
    assert.strictEqual(S(oldObs).disposition, "held_not_done");
    const trusted = reconcileTerminalArrival({
      record: pending,
      arrival: arrivalFor(),
      serverObservation: obsFor({ resultRevision: 4 }),
    });
    assert.isTrue(Result.isSuccess(trusted));
    assert.strictEqual(S(trusted).disposition, "advanced");
    assert.isFalse(S(trusted).record.pendingChildRuns);
    const applied = applyServerObservation({
      record: pending,
      observation: obsFor({ resultRevision: 3, stage: "observed" }),
    });
    assert.isTrue(Result.isSuccess(applied));
    assert.isFalse(S(applied).record.pendingChildRuns);
    assert.strictEqual(S(applied).record.state, "observed");
  });
  it("failed or frozen results cannot be accepted or integrated", () => {
    const failedReviewed = { ...reviewedRecord(), outcome: "failed" as const };
    const a = acceptMissionResult({
      record: failedReviewed,
      receipt: receipt({ kind: "acceptance" }),
    });
    assert.isTrue(Result.isFailure(a));
    const frozenReviewed = { ...reviewedRecord(), cancellationRequested: true };
    const b = acceptMissionResult({
      record: frozenReviewed,
      receipt: receipt({ kind: "acceptance" }),
    });
    assert.isTrue(Result.isFailure(b));
    assert.strictEqual(F(b).category, "frozen");
    const pendingReviewed = { ...reviewedRecord(), pendingChildRuns: true };
    const c = acceptMissionResult({
      record: pendingReviewed,
      receipt: receipt({ kind: "acceptance" }),
    });
    assert.isTrue(Result.isFailure(c));
    assert.strictEqual(F(c).category, "pending_children");
  });
  it("source acceptance with check evidence and git integration without installation, then separate installed delivery", () => {
    const accepted = acceptedRecord();
    assert.strictEqual(accepted.state, "accepted");
    assert.isUndefined(accepted.installedDeliveryReceipt);
    const integrated = integratedRecord();
    assert.strictEqual(integrated.state, "integrated");
    assert.isUndefined(integrated.installedDeliveryReceipt);
    const wrongBuild = recordInstalledDelivery({
      record: integrated,
      receipt: receipt({
        kind: "installed_delivery",
        evidenceKind: "installed_delivery",
        evidenceRef: "build:wrong",
      }),
      expectedBuildRef: "build:exact-1",
    });
    assert.isTrue(Result.isFailure(wrongBuild));
    assert.strictEqual(F(wrongBuild).category, "evidence_mismatch");
    const checkAsInstall = recordInstalledDelivery({
      record: integrated,
      receipt: receipt({
        kind: "installed_delivery",
        evidenceKind: "check_pass",
        evidenceRef: "build:exact-1",
      }),
      expectedBuildRef: "build:exact-1",
    });
    assert.isTrue(Result.isFailure(checkAsInstall));
    assert.strictEqual(F(checkAsInstall).category, "not_installed_delivery");
    const installed = recordInstalledDelivery({
      record: integrated,
      receipt: receipt({
        kind: "installed_delivery",
        evidenceKind: "installed_delivery",
        evidenceRef: "build:exact-1",
      }),
      expectedBuildRef: "build:exact-1",
    });
    assert.isTrue(Result.isSuccess(installed));
    assert.strictEqual(S(installed).record.installedDeliveryReceipt?.evidenceRef, "build:exact-1");
    assert.strictEqual(S(installed).record.state, "integrated");
    const policyBlocked = acceptMissionResult({
      record: reviewedRecord(),
      receipt: receipt({ kind: "acceptance", evidenceKind: "check_pass" }),
      evidencePolicy: {
        acceptanceEvidenceKinds: ["test_report"],
        integrationEvidenceKinds: ["merge_back"],
      },
    });
    assert.isTrue(Result.isFailure(policyBlocked));
    assert.strictEqual(F(policyBlocked).category, "evidence_mismatch");
  });
  it("acceptance checks the existing review still binds the current provenance", () => {
    const staleReview = {
      ...reviewedRecord(),
      reviewReceipt: receipt({ commitSet: ["commit:zzz"] }),
    };
    const d = acceptMissionResult({
      record: staleReview,
      receipt: receipt({ kind: "acceptance" }),
    });
    assert.isTrue(Result.isFailure(d));
    assert.strictEqual(F(d).category, "evidence_mismatch");
  });
  it("produced->delivered->observed transitions, ACK is metadata only while awaiting review, validation is not restart", () => {
    const delivered = markMissionResultDelivered({ record: recordFor() });
    assert.isTrue(Result.isSuccess(delivered));
    assert.strictEqual(S(delivered).record.state, "delivered");
    const observed = markMissionResultObserved({ record: S(delivered).record });
    assert.isTrue(Result.isSuccess(observed));
    assert.strictEqual(S(observed).record.state, "observed");
    const acked = acknowledgeMailboxDelivery({ record: S(observed).record });
    assert.isTrue(Result.isSuccess(acked));
    assert.strictEqual(S(acked).record.state, "observed");
    assert.isTrue(S(acked).record.mailboxAcked);
    const validated = validateRecordAfterRestart({ record: S(acked).record });
    assert.isTrue(Result.isSuccess(validated));
    assert.strictEqual(S(validated).record.state, "observed");
    const rebuilt = reconstructAfterRestart({ record: S(acked).record });
    assert.isTrue(Result.isSuccess(rebuilt));
    assert.strictEqual(S(rebuilt).record.state, "observed");
  });
  it("fresh later terminal wins, stale/quarantine dedups, frozen holds, no regression preserves integration", () => {
    const fresh = reconcileTerminalArrival({ record: recordFor(), arrival: arrivalFor() });
    assert.isTrue(Result.isSuccess(fresh));
    assert.strictEqual(S(fresh).record.state, "observed");
    assert.strictEqual(S(fresh).record.outcome, "completed");
    const current = recordFor({
      state: "observed",
      outcome: "completed",
      summaryText: "Current terminal wins.",
    });
    const staleArrival = arrivalFor({
      outcome: "failed",
      summaryText: "Late stale failure.",
      attemptNumber: 1,
      provenance: provenanceFor({ resultRevision: 1 }),
    });
    const once = reconcileTerminalArrival({ record: current, arrival: staleArrival });
    assert.isTrue(Result.isSuccess(once));
    const twice = reconcileTerminalArrival({ record: S(once).record, arrival: staleArrival });
    assert.isTrue(Result.isSuccess(twice));
    assert.strictEqual(S(twice).record.quarantined.length, 1);
    const frozen = reconcileTerminalArrival({
      record: recordFor({ state: "observed", cancellationRequested: true }),
      arrival: arrivalFor({ outcome: "cancelled", summaryText: "Late cancelled." }),
    });
    assert.isTrue(Result.isSuccess(frozen));
    assert.strictEqual(S(frozen).disposition, "held_frozen");
    const late = reconcileTerminalArrival({
      record: integratedRecord(),
      arrival: arrivalFor({
        summaryText: "Delayed old.",
        provenance: provenanceFor({ resultRevision: 2 }),
      }),
    });
    assert.isTrue(Result.isSuccess(late));
    assert.strictEqual(S(late).disposition, "no_regression");
    assert.strictEqual(S(late).record.state, "integrated");
  });
  it("freshness invalidates acceptance but preserves historical integration", () => {
    const changed = checkAcceptanceFreshness({
      record: acceptedRecord(),
      currentDigests: { ...digests, inputDigest: "input:changed" },
    });
    assert.isTrue(Result.isSuccess(changed));
    assert.strictEqual(S(changed).disposition, "invalidated");
    assert.strictEqual(S(changed).record.state, "observed");
    const hist = checkAcceptanceFreshness({
      record: integratedRecord(),
      currentDigests: { ...digests, inputDigest: "input:changed" },
    });
    assert.isTrue(Result.isSuccess(hist));
    assert.strictEqual(S(hist).record.state, "integrated");
    const intact = checkAcceptanceFreshness({ record: acceptedRecord(), currentDigests: digests });
    assert.isTrue(Result.isSuccess(intact));
    assert.strictEqual(S(intact).record.state, "accepted");
  });
});
