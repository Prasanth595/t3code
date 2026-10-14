import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import {
  computeRetroReportHash,
  reconcileRetroReport,
  withActualReportHash,
  type MissionRetroReportContext,
  type MissionRetroReportDecision,
  type MissionRetroReportReconciliationResult,
  type MissionRetroReport as MissionRetroReportValue,
  type MissionRetroReportCandidate as MissionRetroReportCandidateValue,
  type MissionRetroReportIncident as MissionRetroReportIncidentValue,
} from "./MissionRetroReportReconciliation.ts";

const S = (r: MissionRetroReportReconciliationResult): MissionRetroReportDecision => {
  if (Result.isFailure(r)) throw new Error(`expected success: ${r.failure.message}`);
  return r.success;
};
const F = (r: MissionRetroReportReconciliationResult) => {
  if (Result.isSuccess(r)) throw new Error("expected failure");
  return r.failure;
};

const sha = (ch: string): string => ch.repeat(64);
const HASH_A = sha("a");
const HASH_B = sha("b");
const HASH_REPORT = sha("c");
const HASH_OTHER = sha("d");

const chunkA = {
  rootRef: "log:root-400",
  chunkRef: "chunk-00",
  chunkHash: HASH_A,
  coveredFromInclusive: 0,
  coveredToExclusive: 200,
};
const chunkB = {
  rootRef: "log:root-400",
  chunkRef: "chunk-01",
  chunkHash: HASH_B,
  coveredFromInclusive: 200,
  coveredToExclusive: 400,
};

const contextFor = (
  o: {
    assignment?: Partial<MissionRetroReportContext["assignment"]>;
    coverage?: Partial<MissionRetroReportContext["coverage"]>;
    priorAccepted?: MissionRetroReportContext["priorAccepted"];
  } = {},
): MissionRetroReportContext => ({
  expectedCheckpoint: {
    checkpointId: "retro-checkpoint-1",
    teamId: "team:nofun",
    environmentId: "env:mac-1",
    missionId: "mission:one",
    sourceThreadId: "thread:origin-root",
    sourceRoot: "log:root-400",
    snapshotFingerprint: sha("f"),
    fromInclusive: 0,
    toExclusive: 400,
  },
  assignment: {
    reporterChildThreadId: "thread:reporter-1",
    reporterRunId: "run:reporter-1:1",
    reportRevision: 1,
    assignmentToken: "token:abc",
    managerEpoch: 7,
    requestedModel: "muse-spark-1.3-contributor",
    requestedProfile: "muse-review",
    verifiedCompany: "No Fun",
    verifiedAccountRef: "account:nofun-verified",
    verifiedProviderRef: "provider:nofun-verified",
    status: "active",
    actualOrigin: "subagent-run",
    ...o.assignment,
  },
  coverage: {
    manifestSourceRefs: [chunkA, chunkB],
    readReceipts: [chunkA, chunkB],
    apiCoverage: "full",
    childLogCoverage: "full",
    rawStdoutCoverage: "full",
    pendingChildRuns: false,
    ...o.coverage,
  },
  priorAccepted: o.priorAccepted,
});

const reportFor = (o: Partial<MissionRetroReportValue> = {}): MissionRetroReportValue => {
  const base: MissionRetroReportValue = {
    checkpointId: "retro-checkpoint-1",
    teamId: "team:nofun",
    environmentId: "env:mac-1",
    missionId: "mission:one",
    sourceThreadId: "thread:origin-root",
    sourceRoot: "log:root-400",
    snapshotFingerprint: sha("f"),
    coveredFromInclusive: 0,
    coveredToExclusive: 400,
    reporterChildThreadId: "thread:reporter-1",
    reporterRunId: "run:reporter-1:1",
    reportRevision: 1,
    reportHash: HASH_REPORT,
    assignmentToken: "token:abc",
    managerEpoch: 7,
    model: "muse-spark-1.3-contributor",
    profile: "muse-review",
    sourceRefs: [chunkA, chunkB],
    claimedReadRefs: [],
    summary: "Bounded summary of the analyzed boundary.",
    verdict: "no_change",
    shortlist: [],
    incidents: [],
    skillEvidence: [],
    omissions: [],
    ...o,
  };
  // Fixtures carry the computed actual hash unless a test pins one explicitly.
  return o.reportHash === undefined ? withActualReportHash(base) : base;
};

const incidentFor = (o: Partial<MissionRetroReportIncidentValue> = {}): MissionRetroReportIncidentValue => ({
  incidentId: "incident:1",
  concernId: "concern:scope",
  sourceEventRef: "event:303",
  summary: "Worker installed dependencies despite a no-install packet.",
  destinationOwner: "project_guidance",
  ...o,
});

const candidateFor = (
  o: Partial<MissionRetroReportCandidateValue> = {},
): MissionRetroReportCandidateValue => ({
  candidateId: "candidate:1",
  concernId: "concern:scope",
  incidentRefs: ["incident:1"],
  summary: "Tighten the packet scope clause with the lockfile reason.",
  destinationOwner: "project_guidance",
  alreadyFixed: false,
  ...o,
});

describe("MissionRetroReportReconciliation", () => {
  it("accepts a trusted fully covered zero-findings report as no_change", () => {
    const d = S(reconcileRetroReport({ context: contextFor(), report: reportFor() }));
    assert.strictEqual(d.disposition, "queued_for_triage");
    assert.strictEqual(d.verdict, "no_change");
    assert.strictEqual(d.coverage.full, true);
  });

  it("forces partial_coverage for a missing chunk even when the worker claims no_change", () => {
    const context = contextFor({ coverage: { readReceipts: [chunkA] } });
    const d = S(reconcileRetroReport({ context, report: reportFor({ verdict: "no_change" }) }));
    assert.strictEqual(d.disposition, "held_partial");
    assert.strictEqual(d.verdict, "partial_coverage");
    assert.strictEqual(d.coverage.full, false);
  });

  it("quarantines a report from the wrong exact reporter model", () => {
    const d = S(
      reconcileRetroReport({ context: contextFor(), report: reportFor({ model: "other-model" }) }),
    );
    assert.strictEqual(d.disposition, "held_quarantined");
    assert.strictEqual(d.verdict, "partial_coverage");
  });

  it("quarantines a report from the wrong reporter profile", () => {
    const d = S(
      reconcileRetroReport({ context: contextFor(), report: reportFor({ profile: "read-write" }) }),
    );
    assert.strictEqual(d.disposition, "held_quarantined");
  });

  it("quarantines a report anchored to a foreign source thread", () => {
    const d = S(
      reconcileRetroReport({
        context: contextFor(),
        report: reportFor({ sourceThreadId: "thread:foreign" }),
      }),
    );
    assert.strictEqual(d.disposition, "held_quarantined");
  });

  it("quarantines a foreign fingerprint or manager epoch", () => {
    const finger = S(
      reconcileRetroReport({
        context: contextFor(),
        report: reportFor({ snapshotFingerprint: HASH_OTHER }),
      }),
    );
    assert.strictEqual(finger.disposition, "held_quarantined");
    const epoch = S(
      reconcileRetroReport({ context: contextFor(), report: reportFor({ managerEpoch: 8 }) }),
    );
    assert.strictEqual(epoch.disposition, "held_quarantined");
  });

  it("never advances a report against a superseded or revoked assignment", () => {
    for (const status of ["superseded", "revoked"] as const) {
      const d = S(
        reconcileRetroReport({ context: contextFor({ assignment: { status } }), report: reportFor() }),
      );
      assert.strictEqual(d.disposition, "held_quarantined");
    }
  });

  it("recovers an exact accepted repeat with no second disposition", () => {
    const original = reportFor();
    const context = contextFor({
      priorAccepted: { reportRevision: 1, reportHash: computeRetroReportHash(original) },
    });
    const d = S(reconcileRetroReport({ context, report: original }));
    assert.strictEqual(d.disposition, "recovered_duplicate");
  });

  it("conflicts on the same revision with a changed hash", () => {
    const context = contextFor({ priorAccepted: { reportRevision: 1, reportHash: HASH_OTHER } });
    const d = S(reconcileRetroReport({ context, report: reportFor() }));
    assert.strictEqual(d.disposition, "held_conflict");
  });

  it("stays partial on truncated api or unknown child and raw-stdout coverage", () => {
    const context = contextFor({
      coverage: { apiCoverage: "partial", childLogCoverage: "unknown", rawStdoutCoverage: "unknown" },
    });
    const d = S(reconcileRetroReport({ context, report: reportFor() }));
    assert.strictEqual(d.disposition, "held_partial");
    assert.strictEqual(d.verdict, "partial_coverage");
  });

  it("merges overlapping receipt ranges but leaves gaps unknown", () => {
    const overlap = {
      ...chunkB,
      coveredFromInclusive: 200,
      coveredToExclusive: 300,
    };
    const overlapTail = {
      ...chunkB,
      coveredFromInclusive: 250,
      coveredToExclusive: 400,
    };
    const merged = contextFor({ coverage: { readReceipts: [chunkA, overlap, overlapTail] } });
    const found = S(
      reconcileRetroReport({
        context: merged,
        report: reportFor({ verdict: "candidates", shortlist: [candidateFor()], incidents: [incidentFor()] }),
      }),
    );
    assert.strictEqual(found.disposition, "queued_for_triage");
    assert.strictEqual(found.verdict, "candidates");
    const gapped = contextFor({ coverage: { readReceipts: [chunkA, overlap] } });
    const partial = S(reconcileRetroReport({ context: gapped, report: reportFor() }));
    assert.strictEqual(partial.disposition, "held_partial");
  });

  it("ignores forged worker read receipts when trusted receipts are incomplete", () => {
    const context = contextFor({ coverage: { readReceipts: [chunkA] } });
    const d = S(
      reconcileRetroReport({
        context,
        report: reportFor({ verdict: "no_change", claimedReadRefs: ["chunk-00", "chunk-01"] }),
      }),
    );
    assert.strictEqual(d.disposition, "held_partial");
    assert.strictEqual(d.verdict, "partial_coverage");
  });

  it("denies malformed inputs and out-of-bounds or unknown worker refs", () => {
    const malformed = F(reconcileRetroReport({ context: contextFor(), report: { bogus: true } }));
    assert.strictEqual(malformed.category, "malformed");
    const outside = F(
      reconcileRetroReport({
        context: contextFor(),
        report: reportFor({
          sourceRefs: [{ ...chunkA, coveredToExclusive: 500 }],
        }),
      }),
    );
    assert.strictEqual(outside.category, "out_of_bounds");
    const unknown = F(
      reconcileRetroReport({
        context: contextFor(),
        report: reportFor({
          sourceRefs: [
            {
              rootRef: "log:root-400",
              chunkRef: "chunk-99",
              chunkHash: HASH_A,
              coveredFromInclusive: 0,
              coveredToExclusive: 10,
            },
          ],
        }),
      }),
    );
    assert.strictEqual(unknown.category, "unknown_source_ref");
  });

  it("preserves the full evidence index while deduping normalized duplicates", () => {
    const duplicate = incidentFor({ incidentId: "incident:1-dup" });
    const other = incidentFor({
      incidentId: "incident:2",
      concernId: "concern:evidence",
      sourceEventRef: "event:279",
      summary: "Stub harness presented as acceptance evidence.",
      destinationOwner: "task_recovery",
    });
    const d = S(
      reconcileRetroReport({
        context: contextFor(),
        report: reportFor({
          verdict: "candidates",
          shortlist: [candidateFor({ incidentRefs: ["incident:1", "incident:1-dup", "incident:2"] })],
          incidents: [incidentFor(), duplicate, other],
        }),
      }),
    );
    assert.strictEqual(d.disposition, "queued_for_triage");
    assert.strictEqual(d.report.incidents.length, 2);
    assert.deepStrictEqual(d.report.shortlist[0]?.incidentRefs, ["incident:1", "incident:2"]);
  });

  it("denies invalid shortlist refs and conflicting incident ids", () => {
    const dangling = F(
      reconcileRetroReport({
        context: contextFor(),
        report: reportFor({
          verdict: "candidates",
          shortlist: [candidateFor({ incidentRefs: ["incident:ghost"] })],
          incidents: [incidentFor()],
        }),
      }),
    );
    assert.strictEqual(dangling.category, "invalid_shortlist_ref");
    const conflict = F(
      reconcileRetroReport({
        context: contextFor(),
        report: reportFor({
          verdict: "candidates",
          shortlist: [],
          incidents: [incidentFor(), incidentFor({ sourceEventRef: "event:999" })],
        }),
      }),
    );
    assert.strictEqual(conflict.category, "conflicting_incidents");
  });

  it("keeps missing skill resolution unknown and never upgrades reference_loaded", () => {
    const loaded = {
      skillPath: "skills/retro/SKILL.md",
      observedRevision: HASH_A,
      expectedApplicability: "applicable",
      discovery: "installed",
      invocation: "reference_loaded",
      application: "applied",
      outcome: "untested",
    } as const;
    const d = S(
      reconcileRetroReport({
        context: contextFor({
          coverage: {
            trustedSkillLoads: [{ skillPath: loaded.skillPath, observedRevision: HASH_A, invocation: "reference_loaded" }],
          },
        }),
        report: reportFor({ skillEvidence: [{ ...loaded }] }),
      }),
    );
    assert.strictEqual(d.disposition, "queued_for_triage");
    assert.strictEqual(d.report.skillEvidence[0]?.invocation, "reference_loaded");
    const unproven = F(
      reconcileRetroReport({
        context: contextFor(),
        report: reportFor({
          skillEvidence: [
            {
              skillPath: "skills/retro/SKILL.md",
              expectedApplicability: "applicable",
              discovery: "installed",
              invocation: "reference_loaded",
              application: "applied",
              outcome: "untested",
            },
          ],
        }),
      }),
    );
    assert.strictEqual(unproven.category, "malformed");
  });
});


it("does not recover changed report content carrying the prior claimed hash", () => {
  const original = reportFor();
  const context = contextFor({
    priorAccepted: {
      reportRevision: original.reportRevision,
      reportHash: computeRetroReportHash(original),
    },
  });
  const decision = S(reconcileRetroReport({ context, report: { ...original, summary: "changed content" } }));
  assert.notStrictEqual(decision.disposition, "recovered_duplicate");
  assert.strictEqual(decision.disposition, "held_conflict");
});

it("does not mark an empty manifest as fully covered", () => {
  const context = contextFor({ coverage: { manifestSourceRefs: [], readReceipts: [] } });
  const decision = S(reconcileRetroReport({ context, report: reportFor({ sourceRefs: [] }) }));
  assert.strictEqual(decision.verdict, "partial_coverage");
});

it("does not hide gaps between fully read manifest chunks", () => {
  const shortened = { ...chunkA, coveredToExclusive: 100 };
  const context = contextFor({ coverage: { manifestSourceRefs: [shortened, chunkB], readReceipts: [shortened, chunkB] } });
  const decision = S(reconcileRetroReport({ context, report: reportFor({ sourceRefs: [shortened, chunkB] }) }));
  assert.strictEqual(decision.verdict, "partial_coverage");
});

it("rejects an incident ID reused for a different already-seen concern", () => {
  const other = incidentFor({ incidentId: "incident:2", concernId: "concern:other", sourceEventRef: "event:other" });
  const report = reportFor({ incidents: [incidentFor(), other, incidentFor({ incidentId: "incident:2" })] });
  assert.strictEqual(F(reconcileRetroReport({ context: contextFor(), report })).category, "conflicting_incidents");
});

it("does not recover tampered incidents carrying the prior claimed hash", () => {
  const original = reportFor({ incidents: [incidentFor()] });
  const context = contextFor({
    priorAccepted: {
      reportRevision: original.reportRevision,
      reportHash: computeRetroReportHash(original),
    },
  });
  const tampered = { ...original, incidents: [incidentFor({ summary: "tampered" })] };
  const decision = S(reconcileRetroReport({ context, report: tampered }));
  assert.strictEqual(decision.disposition, "held_conflict");
});

it("denies excess wire properties instead of ignoring them", () => {
  const failure = F(
    reconcileRetroReport({
      context: contextFor(),
      report: { ...reportFor(), unexpectedField: "tampered" },
    }),
  );
  assert.strictEqual(failure.category, "malformed");
});

it("denies unknown or mismatched trusted read receipts", () => {
  const unknown = F(
    reconcileRetroReport({
      context: contextFor({
        coverage: { readReceipts: [{ ...chunkA, chunkRef: "chunk-99" }] },
      }),
      report: reportFor(),
    }),
  );
  assert.strictEqual(unknown.category, "coverage_denied");
  const mismatched = F(
    reconcileRetroReport({
      context: contextFor({
        coverage: { readReceipts: [{ ...chunkA, chunkHash: HASH_B }, chunkB] },
      }),
      report: reportFor(),
    }),
  );
  assert.strictEqual(mismatched.category, "coverage_denied");
});

it("fails closed on a duplicate manifest chunk with a differing hash", () => {
  const failure = F(
    reconcileRetroReport({
      context: contextFor({
        coverage: { manifestSourceRefs: [chunkA, { ...chunkA, chunkHash: HASH_B }, chunkB] },
      }),
      report: reportFor(),
    }),
  );
  assert.strictEqual(failure.category, "coverage_denied");
});

it("downgrades unproven skill claims without a trusted load receipt", () => {
  const claimed = {
    skillPath: "skills/retro/SKILL.md",
    observedRevision: HASH_A,
    expectedApplicability: "applicable",
    discovery: "installed",
    invocation: "native_invoked",
    application: "applied",
    outcome: "success_behavior",
  } as const;
  const d = S(
    reconcileRetroReport({ context: contextFor(), report: reportFor({ skillEvidence: [{ ...claimed }] }) }),
  );
  assert.strictEqual(d.report.skillEvidence[0]?.invocation, "unknown");
  assert.strictEqual(d.report.skillEvidence[0]?.discovery, "unknown");
  assert.strictEqual(d.report.skillEvidence[0]?.application, "unknown");
  assert.strictEqual(d.report.skillEvidence[0]?.outcome, "unknown");
});

it("quarantines when verified account facts are absent", () => {
  const d = S(
    reconcileRetroReport({
      context: contextFor({ assignment: { verifiedAccountRef: "", verifiedProviderRef: "" } }),
      report: reportFor(),
    }),
  );
  assert.strictEqual(d.disposition, "held_quarantined");
});


it("does not infer native invocation, application, or behavior from a path/hash resolution", () => {
  const skill = { skillPath: "skills/retro/SKILL.md", observedRevision: HASH_A,
    expectedApplicability: "applicable", discovery: "installed", invocation: "native_invoked",
    application: "applied", outcome: "success_behavior" } as const;
  const context = contextFor({ coverage: { trustedSkillLoads: [{ skillPath: skill.skillPath, observedRevision: HASH_A }] } });
  const decision = S(reconcileRetroReport({ context, report: reportFor({ skillEvidence: [skill] }) }));
  assert.notStrictEqual(decision.report.skillEvidence[0]!.invocation, "native_invoked");
  assert.strictEqual(decision.report.skillEvidence[0]!.application, "unknown");
  assert.strictEqual(decision.report.skillEvidence[0]!.outcome, "unknown");
});

it("keeps normalized report bytes bound to their own hash", () => {
  const decision = S(reconcileRetroReport({ context: contextFor(), report: reportFor({ incidents: [incidentFor(), incidentFor({ incidentId: "alias" })] }) }));
  assert.strictEqual(computeRetroReportHash(decision.report), decision.report.reportHash);
});

it("preserves the submitted input hash independently of normalized bytes", () => {
  const source = reportFor({ incidents: [incidentFor(), incidentFor({ incidentId: "alias" })] });
  const decision = S(reconcileRetroReport({ context: contextFor(), report: source }));
  assert.strictEqual(decision.sourceReportHash, computeRetroReportHash(source));
  assert.notStrictEqual(decision.sourceReportHash, decision.report.reportHash);
  const replay = S(reconcileRetroReport({ context: contextFor({ priorAccepted: { reportRevision: 1, reportHash: decision.sourceReportHash } }), report: source }));
  assert.strictEqual(replay.disposition, "recovered_duplicate");
});
