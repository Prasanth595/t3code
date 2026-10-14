import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  reconcileSkillEvaluation,
  type SkillEvaluationDecision,
  type SkillEvaluationFixtureClass,
  type SkillEvaluationReconciliationResult,
  type SkillEvaluationTrustedContext,
  type SkillEvaluationTrustedObservation,
  type SkillEvaluationTrustedPair,
} from "./MissionRetroSkillEvaluation.ts";

const S = (r: SkillEvaluationReconciliationResult): SkillEvaluationDecision => {
  if (Result.isFailure(r)) {
    throw new Error(`expected success: ${r.failure.message} :: ${r.failure.detail ?? ""}`);
  }
  return r.success;
};
const F = (r: SkillEvaluationReconciliationResult) => {
  if (Result.isSuccess(r)) throw new Error("expected success, got failure");
  return r.failure;
};

const sha = (ch: string): string => ch.repeat(64);
const OLD_SNAP = sha("a");
const NEW_SNAP = sha("b");
const CONFIG = sha("c");
const SOURCE_REPORT = sha("d");
const NORMALIZED_REPORT = sha("e");
const FIXTURE_HASH: Record<SkillEvaluationFixtureClass, string> = {
  failure: sha("f"),
  positive: sha("1"),
  negative: sha("2"),
};

let seq = 0;
const obs = (
  fixtureClass: SkillEvaluationFixtureClass,
  side: "old" | "new",
  o: Partial<SkillEvaluationTrustedObservation> = {},
): SkillEvaluationTrustedObservation => {
  seq += 1;
  return {
    runRef: `run:${fixtureClass}:${side}:${seq}`,
    contextId: `ctx:${fixtureClass}:${side}:${seq}`,
    fixtureId: `fixture:${fixtureClass}`,
    fixtureHash: FIXTURE_HASH[fixtureClass],
    configDigest: CONFIG,
    observedSkillSha256: side === "old" ? OLD_SNAP : NEW_SNAP,
    outcome: side === "old" ? "fail" : "pass",
    skillTriggered: false,
    unnecessaryLoads: 0,
    repeatedLookups: 0,
    completionQuality: "ok",
    ...o,
  };
};

const pairFor = (
  fixtureClass: SkillEvaluationFixtureClass,
  old: Partial<SkillEvaluationTrustedObservation> = {},
  young: Partial<SkillEvaluationTrustedObservation> = {},
): SkillEvaluationTrustedPair => ({
  fixtureClass,
  old: obs(fixtureClass, "old", fixtureClass === "positive"
    ? { outcome: "pass", skillTriggered: true, ...old }
    : fixtureClass === "negative"
      ? { outcome: "pass", ...old }
      : old),
  new: obs(fixtureClass, "new", fixtureClass === "positive" ? { skillTriggered: true, ...young } : young),
});

const cleanPairs = (): [SkillEvaluationTrustedPair, SkillEvaluationTrustedPair, SkillEvaluationTrustedPair] => [
  pairFor("failure"),
  pairFor("positive"),
  pairFor("negative"),
];

const contextFor = (
  o: Partial<SkillEvaluationTrustedContext> = {},
): SkillEvaluationTrustedContext => ({
  scope: {
    teamId: "team:nofun",
    environmentId: "env:mac-1",
    originMissionId: "mission:one",
    candidateId: "candidate:1",
    targetSkillRef: "skills/retro-reporter/SKILL.md",
    sourceReportHash: SOURCE_REPORT,
    normalizedReportHash: NORMALIZED_REPORT,
  },
  authorId: "author:writer-1",
  reviewerId: "reviewer:independent-1",
  oldSnapshotDigest: OLD_SNAP,
  newSnapshotDigest: NEW_SNAP,
  ownership: "owned-isolated",
  configDigest: CONFIG,
  runMode: "deterministic",
  requiredRepeatCount: 1,
  telemetryComplete: true,
  leakageCheck: "pass",
  pairs: cleanPairs(),
  ...o,
});

const candidateFor = (o: Record<string, unknown> = {}) => ({
  candidateId: "candidate:1",
  targetSkillRef: "skills/retro-reporter/SKILL.md",
  sourceReportHash: SOURCE_REPORT,
  claimedPass: true,
  ...o,
});

describe("MissionRetroSkillEvaluation", () => {
  it("marks a complete matched clean independent 3-class replay review_ready", () => {
    const d = S(reconcileSkillEvaluation({ context: contextFor(), candidate: candidateFor() }));
    assert.strictEqual(d.kind, "review_ready");
    assert.strictEqual(d.reason, "ready_fix_verified");
    assert.strictEqual(d.uncertainty, "observed_pairs_only");
    assert.deepStrictEqual(d.failurePairs, { required: 1, observed: 1, oldPass: 0, newPass: 1 });
  });

  it("reports no_change for identical snapshots with clean all-pass evidence", () => {
    const context = contextFor({
      newSnapshotDigest: OLD_SNAP,
      pairs: [
        pairFor("failure", { outcome: "pass" }, { observedSkillSha256: OLD_SNAP }),
        pairFor("positive"),
        pairFor("negative"),
      ],
    });
    const fixed = {
      ...context,
      pairs: context.pairs.map((pair) => ({
        ...pair,
        new: { ...pair.new, observedSkillSha256: OLD_SNAP },
      })),
    };
    const d = S(reconcileSkillEvaluation({ context: fixed, candidate: candidateFor() }));
    assert.strictEqual(d.kind, "no_change");
  });

  it.each([
    ["original failure not reproduced on baseline", "failure", { outcome: "pass" }, {}, "hold_no_failure_reproduced"],
    ["no improvement on the failure fixture", "failure", {}, { outcome: "fail" }, "hold_no_improvement"],
    ["missing negative class", "negative-missing", {}, {}, "hold_missing_class"],
    ["unknown per-run telemetry", "telemetry", {}, {}, "hold_unknown_telemetry"],
    ["leakage unknown", "leakage", {}, {}, "hold_leakage_unknown"],
    ["same author and reviewer", "identity", {}, {}, "hold_not_independent"],
    ["upstream ownership", "ownership", {}, {}, "hold_upstream_ownership"],
  ] as const)(
    "holds when %s",
    ( _name, variant, oldOverride, newOverride, reason ) => {
      let context = contextFor();
      if (variant === "failure") {
        context = contextFor({
          pairs: [pairFor("failure", oldOverride, newOverride), pairFor("positive"), pairFor("negative")],
        });
      } else if (variant === "negative-missing") {
        context = contextFor({ pairs: [pairFor("failure"), pairFor("positive")] });
      } else if (variant === "telemetry") {
        context = contextFor({
          pairs: [pairFor("failure"), pairFor("positive"), pairFor("negative", {}, { completionQuality: "unknown" })],
        });
      } else if (variant === "leakage") {
        context = contextFor({ leakageCheck: "unknown" });
      } else if (variant === "identity") {
        context = contextFor({ reviewerId: "author:writer-1" });
      } else if (variant === "ownership") {
        context = contextFor({ ownership: "upstream" });
      }
      void oldOverride;
      void newOverride;
      const d = S(reconcileSkillEvaluation({ context, candidate: candidateFor() }));
      assert.strictEqual(d.kind, "hold");
      assert.strictEqual(d.reason, reason);
    },
  );

  it.each([
    ["positive regression to fail", "positive", { outcome: "fail" }, "rejected_regression"],
    ["negative false-trigger to fail", "negative-fail", { outcome: "fail" }, "rejected_false_trigger"],
    ["negative newly triggers the skill", "negative-trigger", { skillTriggered: true }, "rejected_false_trigger"],
    ["added unnecessary loads on positive", "loads", { unnecessaryLoads: 3 }, "rejected_load_regression"],
    ["added repeated lookups on negative", "lookups", { repeatedLookups: 2 }, "rejected_load_regression"],
    ["degraded completion on the new side", "degraded", { completionQuality: "degraded" }, "rejected_regression"],
    ["leakage evidence fails", "leakage-fail", {}, "rejected_leakage"],
  ] as const)("rejects when %s", (_name, variant, newOverride, reason) => {
    let context = contextFor();
    if (variant === "positive") {
      context = contextFor({ pairs: [pairFor("failure"), pairFor("positive", {}, newOverride), pairFor("negative")] });
    } else if (variant === "negative-fail") {
      context = contextFor({ pairs: [pairFor("failure"), pairFor("positive"), pairFor("negative", { outcome: "pass" }, newOverride)] });
    } else if (variant === "negative-trigger") {
      context = contextFor({ pairs: [pairFor("failure"), pairFor("positive"), pairFor("negative", { outcome: "pass" }, newOverride)] });
    } else if (variant === "loads") {
      context = contextFor({ pairs: [pairFor("failure"), pairFor("positive", {}, newOverride), pairFor("negative")] });
    } else if (variant === "lookups") {
      context = contextFor({ pairs: [pairFor("failure"), pairFor("positive"), pairFor("negative", { outcome: "pass" }, newOverride)] });
    } else if (variant === "degraded") {
      context = contextFor({ pairs: [pairFor("failure"), pairFor("positive", {}, newOverride), pairFor("negative")] });
    } else if (variant === "leakage-fail") {
      context = contextFor({ leakageCheck: "fail" });
    }
    const d = S(reconcileSkillEvaluation({ context, candidate: candidateFor() }));
    assert.strictEqual(d.kind, "rejected");
    assert.strictEqual(d.reason, reason);
  });

  it("rejects old/new hash drift against the verified snapshots", () => {
    const context = contextFor({
      pairs: [pairFor("failure", { observedSkillSha256: sha("9") }), pairFor("positive"), pairFor("negative")],
    });
    const d = S(reconcileSkillEvaluation({ context, candidate: candidateFor() }));
    assert.strictEqual(d.kind, "rejected");
    assert.strictEqual(d.reason, "rejected_snapshot_mismatch");
  });

  it("rejects config and fixture drift inside a pair", () => {
    const drifted = contextFor({
      pairs: [pairFor("failure", {}, { configDigest: sha("8") }), pairFor("positive"), pairFor("negative")],
    });
    assert.strictEqual(
      S(reconcileSkillEvaluation({ context: drifted, candidate: candidateFor() })).reason,
      "rejected_binding_drift",
    );
  });

  it("rejects source binding drift between candidate and trusted report hash", () => {
    const d = S(
      reconcileSkillEvaluation({ context: contextFor(), candidate: candidateFor({ sourceReportHash: sha("7") }) }),
    );
    assert.strictEqual(d.kind, "rejected");
    assert.strictEqual(d.reason, "rejected_binding_drift");
  });

  it("rejects a worker mutation that retargets the owned skill reference", () => {
    const d = S(
      reconcileSkillEvaluation({
        context: contextFor(),
        candidate: candidateFor({ targetSkillRef: "skills/other/SKILL.md" }),
      }),
    );
    assert.strictEqual(d.kind, "rejected");
    assert.strictEqual(d.reason, "rejected_retarget");
  });

  it("rejects a forged worker pass that no trusted receipt supports", () => {
    const context = contextFor({
      pairs: [
        pairFor("failure", {}, { outcome: "fail" }),
        pairFor("positive", {}, { outcome: "fail" }),
        pairFor("negative", { outcome: "pass" }, { outcome: "fail" }),
      ],
    });
    const d = S(reconcileSkillEvaluation({ context, candidate: candidateFor({ claimedPass: true }) }));
    assert.strictEqual(d.kind, "rejected");
    assert.strictEqual(d.reason, "rejected_forged_receipt");
  });

  it("rejects reused clean contexts and duplicate or conflicting run refs", () => {
    const [failure, positive, negative] = cleanPairs();
    const reused = contextFor({
      pairs: [failure, positive, { ...negative, old: { ...negative.old, contextId: failure.old.contextId } }],
    });
    assert.strictEqual(
      S(reconcileSkillEvaluation({ context: reused, candidate: candidateFor() })).reason,
      "rejected_shared_context",
    );
    const duplicated = contextFor({
      pairs: [failure, positive, { ...negative, old: { ...negative.old, runRef: failure.old.runRef } }],
    });
    assert.strictEqual(
      S(reconcileSkillEvaluation({ context: duplicated, candidate: candidateFor() })).reason,
      "rejected_duplicate_run",
    );
  });

  it("holds stochastic runs with insufficient samples and reports counts", () => {
    const context = contextFor({ runMode: "stochastic", requiredRepeatCount: 2 });
    const d = S(reconcileSkillEvaluation({ context, candidate: candidateFor() }));
    assert.strictEqual(d.kind, "hold");
    assert.strictEqual(d.reason, "hold_insufficient_samples");
    assert.strictEqual(d.failurePairs.required, 2);
    assert.strictEqual(d.failurePairs.observed, 1);
  });

  it("holds mixed stochastic outcomes as instability and accepts matched repeats", () => {
    const mixed = contextFor({
      runMode: "stochastic",
      requiredRepeatCount: 2,
      pairs: [
        pairFor("failure"),
        pairFor("failure", {}, { outcome: "fail" }),
        pairFor("positive"),
        pairFor("positive"),
        pairFor("negative", { outcome: "pass" }, {}),
        pairFor("negative", { outcome: "pass" }, {}),
      ],
    });
    const held = S(reconcileSkillEvaluation({ context: mixed, candidate: candidateFor() }));
    assert.strictEqual(held.kind, "hold");
    assert.strictEqual(held.reason, "hold_unstable_samples");
    assert.strictEqual(held.failurePairs.observed, 2);
    assert.strictEqual(held.failurePairs.newPass, 1);
    const ready = contextFor({
      runMode: "stochastic",
      requiredRepeatCount: 2,
      pairs: [
        pairFor("failure"),
        pairFor("failure"),
        pairFor("positive"),
        pairFor("positive"),
        pairFor("negative", { outcome: "pass" }, {}),
        pairFor("negative", { outcome: "pass" }, {}),
      ],
    });
    assert.strictEqual(
      S(reconcileSkillEvaluation({ context: ready, candidate: candidateFor() })).kind,
      "review_ready",
    );
  });

  it.each([
    ["absolute target path", "/skills/evil/SKILL.md"],
    ["parent traversal", "skills/../evil/SKILL.md"],
    ["encoded traversal", "skills/%2e%2e/evil/SKILL.md"],
  ])("fails finite on unsafe target identifier %s", (_name, targetSkillRef) => {
    const failure = F(
      reconcileSkillEvaluation({ context: contextFor(), candidate: candidateFor({ targetSkillRef }) }),
    );
    assert.strictEqual(failure.operation, "reconcile");
    assert.strictEqual(failure.category, "malformed");
  });

  it("fails finite on oversized pair counts and malformed inputs", () => {
    const tooMany = Array.from({ length: 65 }, () => pairFor("failure"));
    assert.strictEqual(
      F(reconcileSkillEvaluation({ context: contextFor({ pairs: tooMany }), candidate: candidateFor() })).category,
      "oversized",
    );
    assert.strictEqual(
      F(reconcileSkillEvaluation({ context: contextFor(), candidate: { claimedPass: true } })).category,
      "malformed",
    );
    assert.strictEqual(
      F(reconcileSkillEvaluation({ context: contextFor(), candidate: null })).category,
      "malformed",
    );
  });

  it.each([
    ["positive baseline does not trigger the skill", { skillTriggered: false }, {}],
    ["positive candidate does not trigger the skill", {}, { skillTriggered: false }],
  ] as const)("holds when %s", (_name, oldOverride, newOverride) => {
    const context = contextFor({
      pairs: [pairFor("failure"), pairFor("positive", oldOverride, newOverride), pairFor("negative")],
    });
    assert.notStrictEqual(S(reconcileSkillEvaluation({ context, candidate: candidateFor() })).kind, "review_ready");
  });

  it("does not queue a failure fix with degraded completion quality", () => {
    const context = contextFor({
      pairs: [pairFor("failure", {}, { completionQuality: "degraded" }), pairFor("positive"), pairFor("negative")],
    });
    assert.notStrictEqual(S(reconcileSkillEvaluation({ context, candidate: candidateFor() })).kind, "review_ready");
  });

  it("rejects extra keys that try to ride along as alleged proof", () => {
    const result = reconcileSkillEvaluation({
      context: contextFor(),
      candidate: candidateFor({ allegedProof: "self-asserted" }),
    });
    assert.strictEqual(Result.isFailure(result), true);
  });

  it("copies no bodies or private context into the frozen output", () => {
    const d = S(reconcileSkillEvaluation({ context: contextFor(), candidate: candidateFor() }));
    assert.strictEqual(Object.isFrozen(d), true);
    const serialized = stableStringify(d);
    for (const banned of ["prompt", "answer", "transcript", "secret", "token", "body"]) {
      assert.strictEqual(serialized.includes(`"${banned}"`), false);
    }
    assert.strictEqual(serialized.length <= 64 * 1024, true);
    assert.strictEqual(d.uncertainty, "observed_pairs_only");
  });
});

// Root acceptance regressions beyond the initial happy-path suite.
it.each([null, undefined, {}])("malformed envelope %s returns a finite result", (input) => {
  const result = reconcileSkillEvaluation(input as never);
  assert.strictEqual(Result.isFailure(result), true);
});

it("freezes every nested public sample counter", () => {
  const decision = S(reconcileSkillEvaluation({ context: contextFor(), candidate: candidateFor() }));
  assert.isTrue(Object.isFrozen(decision.failurePairs));
  assert.isTrue(Object.isFrozen(decision.positivePairs));
  assert.isTrue(Object.isFrozen(decision.negativePairs));
});

it("never counts changing fixture hashes as repeated samples of one fixture", () => {
  const context = contextFor({ runMode: "stochastic", requiredRepeatCount: 2, pairs: [
    pairFor("failure"), pairFor("failure", { fixtureHash: sha("3") }, { fixtureHash: sha("3") }),
    pairFor("positive"), pairFor("positive"), pairFor("negative"), pairFor("negative"),
  ] });
  assert.notStrictEqual(S(reconcileSkillEvaluation({ context, candidate: candidateFor() })).kind, "review_ready");
});

it("a negative fixture that triggers on both versions is not a clean non-trigger", () => {
  const context = contextFor({ pairs: [pairFor("failure"), pairFor("positive"),
    pairFor("negative", { skillTriggered: true }, { skillTriggered: true })] });
  assert.notStrictEqual(S(reconcileSkillEvaluation({ context, candidate: candidateFor() })).kind, "review_ready");
});

it.each(["skills/%252e%252e/evil/SKILL.md", "https://host/skills/SKILL.md", "C:/skills/SKILL.md"])(
  "rejects nonrelative or recursively encoded skill identifier %s", (targetSkillRef) => {
    const context = contextFor();
    const result = reconcileSkillEvaluation({ context: { ...context, scope: { ...context.scope, targetSkillRef } },
      candidate: candidateFor({ targetSkillRef }) });
    assert.isTrue(Result.isFailure(result));
  },
);

it("the whole unknown metadata envelope is bounded, including excess worker fields", () => {
  const result = reconcileSkillEvaluation({ context: contextFor(), candidate: candidateFor({ body: "x".repeat(70 * 1024) }) });
  assert.isTrue(Result.isFailure(result));
});
