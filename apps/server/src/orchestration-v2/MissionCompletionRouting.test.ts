import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { Mission } from "../../../../packages/contracts/src/mission.ts";
import { MissionResultRecord } from "../../../../packages/contracts/src/missionResult.ts";
import { MissionRetroCheckpoint } from "../../../../packages/contracts/src/missionRetro.ts";
import { MissionRetroAnalysis } from "../../../../packages/contracts/src/missionRetroAnalysis.ts";
import { MissionRetroReportReceipt } from "../../../../packages/contracts/src/missionRetroReportReceipt.ts";
import {
  isCompletionCandidateCurrent,
  resolveCompletionRoute,
  type CompletionRouteCandidate,
  type ResolveCompletionRouteInput,
} from "./MissionCompletionRouting.ts";

const AT = "2026-10-14T00:00:00.000Z";
const AUTHORITY = { source: "mission-council", ref: "decision-2026-001" } as const;
const hex = (pair: string): string => pair.repeat(32);
const FP = hex("a1");
const NORM = hex("b2");
const SRC = hex("c3");
const UUID = "48bef2bf-6d0e-4f7a-9c3b-2e5d8a1f7c40";
const CHILD_TASK = `node:delegated-task:command%3Amcp%3A${UUID}%3Adelegate-task%3Atask-alpha`;
const CHILD_THREAD = `thread:delegated-task:command%3Amcp%3A${UUID}%3Adelegate-task%3Atask-alpha`;
const CHILD_RUN = `run:delegated-task:command%3Amcp%3A${UUID}%3Adelegate-task%3Atask-alpha`;
const REPORTER_THREAD = `thread:delegated-task:command%3Amcp%3A${UUID}%3Adelegate-task%3Areporter`;
const REPORTER_RUN = `run:delegated-task:command%3Amcp%3A${UUID}%3Adelegate-task%3Areporter`;
const SOURCE_THREAD = "thread:origin-root";
const SOURCE_ROOT = "log:root-400";

const decodeMission = Schema.decodeUnknownSync(Mission);
const decodeResultRecord = Schema.decodeUnknownSync(MissionResultRecord);
const decodeCheckpoint = Schema.decodeUnknownSync(MissionRetroCheckpoint);
const decodeAnalysis = Schema.decodeUnknownSync(MissionRetroAnalysis);
const decodeReceipt = Schema.decodeUnknownSync(MissionRetroReportReceipt);

const resultRecordFixture = (overrides: Record<string, unknown> = {}) =>
  decodeResultRecord({
    taskId: "task-alpha", attemptNumber: 2, state: "delivered", outcome: "completed",
    digests: { inputDigest: "in-1", dependencyDigest: "dep-1", acceptanceDigest: "acc-1" },
    provenance: {
      childTaskId: CHILD_TASK, childThreadId: CHILD_THREAD, childRunId: CHILD_RUN,
      commitSet: ["a2ee2aab36da0982634aa5781b9a66dd18a0bc5d"],
      requiredAncestry: ["a2ee2aab36da0982634aa5781b9a66dd18a0bc5d"],
      ancestry: ["a2ee2aab36da0982634aa5781b9a66dd18a0bc5d"],
      source: "t3 TASK_RESULT", sourceRef: "t3:source-ref:101", resultRevision: 5,
    },
    summaryText: "Canonical summary the candidate must never copy.",
    cancellationRequested: false, pendingChildRuns: false, mailboxAcked: false, quarantined: [],
    ...overrides,
  });

const admissionFixture = (overrides: Record<string, unknown> = {}) => ({
  dispatchKey: "dispatch-1", teamId: "team-1", environmentId: "env-1", missionId: "mission-1",
  taskId: "task-alpha", attemptNumber: 2, operation: "write", requestDigest: "req-1",
  admittedAtMs: 1, chosenRoute: { providerInstanceId: "muse-personal", modelId: "muse-wonder-1.0-contributor", profile: "muse-focused" },
  rejectedRoutes: [], accountVerifiedAtMs: 1, hostObservedAtMs: 1, repositoryObservedAtMs: 1,
  accountId: "acct-1", billingMode: "subscription", hostId: "host-1", bootId: "boot-1",
  hostThreadId: "thread-delivery", hostEpoch: 3, unknownUsageException: false,
  unknownUsageExceptionId: null, exceptionConsumptionRef: null, ...overrides,
});

const checkpointFixture = (overrides: Record<string, unknown> = {}) =>
  decodeCheckpoint({
    checkpointId: "chk-1", teamId: "team-1", environmentId: "env-1", missionId: "mission-1",
    sourceThreadId: SOURCE_THREAD, sourceRoot: SOURCE_ROOT, trigger: "milestone",
    requestedReporter: "muse-spark-1.3-contributor", status: "queued_ready", coverage: "full",
    snapshotFingerprint: FP, coveredFromInclusive: 0, coveredToExclusive: 10,
    sourceRefs: [{ rootRef: SOURCE_ROOT, chunkRef: "chunk-1", chunkHash: hex("08"), coveredFromInclusive: 0, coveredToExclusive: 10 }],
    omissions: [], capturedAt: AT, ...overrides,
  });

const leaseFixture = () => ({
  assignmentToken: hex("d4"), reporterChildThreadId: REPORTER_THREAD, reporterRunId: REPORTER_RUN,
  hostId: "host-1", bootId: "boot-1", providerInstanceId: "muse-personal",
  modelId: "muse-spark-1.3-contributor", profile: "muse-review", company: "No Fun",
  accountId: "acct-1", verifiedAccountRef: "account:nofun-verified", verifiedProviderRef: "provider:nofun-verified",
  capacityRef: "capacity-1", hostRef: "host-ref-1", buildRef: "build-1", priorityRef: "priority-1",
  preparedIdentityRef: "prepared-1", claimedAtMs: 1, expiresAtMs: 1000, assignmentRevision: 4, reportRevision: 3,
});

const analysisFixture = (overrides: Record<string, unknown> = {}) =>
  decodeAnalysis({
    checkpointId: "chk-1", teamId: "team-1", environmentId: "env-1", missionId: "mission-1",
    sourceThreadId: SOURCE_THREAD, sourceRoot: SOURCE_ROOT, snapshotFingerprint: FP,
    coveredFromInclusive: 0, coveredToExclusive: 10, managerThreadId: "thread-retro-old",
    managerEpoch: 1, status: "reserved", queueReason: null, fence: 1, attemptNumber: 1,
    lease: leaseFixture(), settlement: null, ...overrides,
  });

const receiptFixture = (overrides: Record<string, unknown> = {}) =>
  decodeReceipt({
    checkpointId: "chk-1", teamId: "team-1", environmentId: "env-1", missionId: "mission-1",
    sourceThreadId: SOURCE_THREAD, sourceRoot: SOURCE_ROOT, snapshotFingerprint: FP,
    coveredFromInclusive: 0, coveredToExclusive: 10, reporterChildThreadId: REPORTER_THREAD,
    reporterRunId: REPORTER_RUN, assignmentToken: hex("d4"), fence: 1, attemptNumber: 1,
    reportRevision: 3, accountId: "acct-1", providerInstanceId: "muse-personal",
    modelId: "muse-spark-1.3-contributor", profile: "muse-review", company: "No Fun",
    originalArtifactRef: "art-orig", originalArtifactSha: hex("e5"), claimedSourceReportHash: SRC,
    sourceReportHash: SRC, normalizedArtifactRef: "art-norm", normalizedArtifactSha: hex("f6"),
    coverageEvidenceRef: "art-cov", coverageEvidenceSha: hex("07"), normalizedReportHash: NORM,
    verdict: "no_change", disposition: "queued_for_triage", coverageFull: true, coverageReasonRefs: [],
    incidentCount: 0, shortlistCount: 0, incidentArtifactRef: "art-idx", receivedAt: AT, quarantine: [],
    ...overrides,
  });

const taskFixture = () => ({
  id: "task-alpha", projectId: "project-1", title: "Alpha", specHash: "hash-1",
  dependencyHashes: [], dependencies: [], acceptanceIds: ["ac-1"],
  attempt: { attemptNumber: 2 }, updatedAt: AT,
});

const missionFixture = (overrides: Record<string, unknown> = {}) =>
  decodeMission({
    schemaVersion: 1, id: "mission-1", revision: 4, teamId: "team-1", authorityEnvironmentId: "env-1",
    bindings: [{ projectId: "project-1", workspaceRoot: "/tmp/project", baseCommit: "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d", ancestry: ["a2ee2aab36da0982634aa5781b9a66dd18a0bc5d"] }],
    intent: {
      outcome: "Ship the opt-in mission aggregate.", scope: ["contracts"], exclusions: ["persistence"],
      authorityRefs: [{ ...AUTHORITY }], acceptanceCriteria: [{ id: "ac-1", text: "Planner validates CAS." }], decisions: [],
    },
    integrationTarget: { summary: "Root store follow-up." },
    managers: { delivery: { threadId: "thread-delivery", epoch: 3 }, retro: { threadId: "thread-retro", epoch: 1 } },
    status: "active", tasks: [taskFixture()],
    execution: {
      admissions: [admissionFixture()], writerClaims: [], consumedExceptionIds: [],
      results: [resultRecordFixture()], retroCheckpoints: [checkpointFixture()],
      retroAnalyses: [analysisFixture()], retroReportReceipts: [receiptFixture()], managerReservations: [],
    },
    updatedAt: AT, ...overrides,
  });

const execWith = (patch: Record<string, unknown>) => {
  const m = missionFixture();
  return missionFixture({ execution: { ...m.execution, ...patch } });
};

const SCOPE = { teamId: "team-1", environmentId: "env-1", missionId: "mission-1" } as const;
const taskRef = {
  kind: "task-result", taskId: "task-alpha", attemptNumber: 2, resultRevision: 5,
  childTaskId: CHILD_TASK, childThreadId: CHILD_THREAD, childRunId: CHILD_RUN,
} as const;
const retroRef = {
  kind: "retro-report", checkpointId: "chk-1", teamId: "team-1", environmentId: "env-1", missionId: "mission-1",
  sourceThreadId: SOURCE_THREAD, sourceRoot: SOURCE_ROOT, snapshotFingerprint: FP,
  coveredFromInclusive: 0, coveredToExclusive: 10, normalizedReportHash: NORM, sourceReportHash: SRC,
  reportRevision: 3, reporterChildThreadId: REPORTER_THREAD, reporterRunId: REPORTER_RUN,
} as const;

const candidateOf = (input: ResolveCompletionRouteInput): CompletionRouteCandidate => {
  const d = resolveCompletionRoute(input);
  if (d.kind !== "candidate") throw new Error(`Expected candidate, got hold ${d.kind}`);
  return d.candidate;
};
const holdOf = (input: ResolveCompletionRouteInput) => {
  const d = resolveCompletionRoute(input);
  expect(d.kind).toBe("hold");
  return d.kind === "hold" ? d : (() => { throw new Error("unreachable"); })();
};

describe("MissionCompletionRouting", () => {
  it("routes an exact persisted task result with canonical task, binding, and admission to current delivery", () => {
    const c = candidateOf({ mission: missionFixture(), scope: { ...SCOPE }, completion: { ...taskRef } });
    expect(c.role).toBe("delivery");
    expect(c.targetThreadId).toBe("thread-delivery");
    expect(c.targetEpoch).toBe(3);
    expect(c.canonicalRevision).toBe(4);
    expect(c.scope).toEqual(SCOPE);
    expect(c.notificationId).toMatch(/^[0-9a-f]{64}$/);
    expect(c.source).toEqual({ ...taskRef });
    expect(Object.keys(c).sort()).toContain("scope");
  });

  it("routes an exact lease-bound retro report to current retro even though analysis manager is historical", () => {
    const c = candidateOf({ mission: missionFixture(), scope: { ...SCOPE }, completion: { ...retroRef } });
    expect(c.role).toBe("retro");
    expect(c.targetThreadId).toBe("thread-retro");
    expect(c.targetEpoch).toBe(1);
    expect(c.source).toEqual({ ...retroRef });
  });

  it("reroutes same completion to current role after rotation with stable notification identity", () => {
    const before = candidateOf({ mission: missionFixture(), scope: { ...SCOPE }, completion: { ...taskRef } });
    const rotated = missionFixture({ revision: 9, managers: { delivery: { threadId: "thread-delivery-next", epoch: 4 }, retro: { threadId: "thread-retro", epoch: 1 } } });
    const after = candidateOf({ mission: rotated, scope: { ...SCOPE }, completion: { ...taskRef } });
    expect(after.targetThreadId).toBe("thread-delivery-next");
    expect(after.notificationId).toBe(before.notificationId);
    expect(after.source).toEqual(before.source);
  });

  it("currentness re-resolves: fresh passes, rotation/revision/pause/foreign-team fail", () => {
    const mission = missionFixture();
    const c = candidateOf({ mission, scope: { ...SCOPE }, completion: { ...taskRef } });
    expect(isCompletionCandidateCurrent(mission, c)).toBe(true);
    expect(isCompletionCandidateCurrent(missionFixture({ revision: 5 }), c)).toBe(false);
    expect(isCompletionCandidateCurrent(missionFixture({ status: "paused" }), c)).toBe(false);
    expect(isCompletionCandidateCurrent(missionFixture({ teamId: "foreign" }), c)).toBe(false);
    expect(isCompletionCandidateCurrent(missionFixture({ managers: { delivery: { threadId: "thread-delivery-next", epoch: 4 }, retro: { threadId: "thread-retro", epoch: 1 } } }), c)).toBe(false);
  });

  it("currentness rejects forged target, epoch, notification, scope, source, and extra keys", () => {
    const mission = missionFixture();
    const c = candidateOf({ mission, scope: { ...SCOPE }, completion: { ...taskRef } });
    expect(isCompletionCandidateCurrent(mission, { ...c, targetThreadId: "thread-forged", observedThreadId: "thread-forged" })).toBe(false);
    expect(isCompletionCandidateCurrent(mission, { ...c, targetEpoch: 99, observedEpoch: 99 })).toBe(false);
    expect(isCompletionCandidateCurrent(mission, { ...c, notificationId: hex("ff") })).toBe(false);
    expect(isCompletionCandidateCurrent(mission, { ...c, scope: { ...SCOPE, teamId: "foreign" } })).toBe(false);
    expect(isCompletionCandidateCurrent(mission, { ...c, scope: { ...SCOPE, environmentId: "foreign" } })).toBe(false);
    expect(isCompletionCandidateCurrent(mission, { ...c, source: { ...c.source, childRunId: CHILD_RUN.replace("task-alpha", "other") } as never })).toBe(false);
    expect(isCompletionCandidateCurrent(mission, { ...c, extra: 1 } as never)).toBe(false);
    expect(isCompletionCandidateCurrent(mission, { ...c, role: "retro" } as never)).toBe(false);
    expect(isCompletionCandidateCurrent(mission, { ...c, canonicalRevision: 99, observedRevision: 99 })).toBe(false);
  });

  it("never targets child, stale parent, or legacy fallback and carries no summary or ready flag", () => {
    const c = candidateOf({ mission: missionFixture(), scope: { ...SCOPE }, completion: { ...taskRef } });
    const body = JSON.stringify(c);
    expect(c.targetThreadId).not.toBe(CHILD_THREAD);
    expect(body).not.toContain("parentThreadId");
    expect(body).not.toContain("completionRoutingReady");
    expect(body).not.toContain("Canonical summary");
    expect(body).not.toContain("summaryText");
  });

  it("holds missing manager without legacy fallback", () => {
    const mission = missionFixture({ managers: { retro: { threadId: "thread-retro", epoch: 1 } } });
    expect(holdOf({ mission, scope: { ...SCOPE }, completion: { ...taskRef } }).reason).toBe("missing_manager");
  });

  it("holds task absent from canonical mission and task with missing admission", () => {
    expect(resolveCompletionRoute({ mission: missionFixture({ tasks: [] }), scope: { ...SCOPE }, completion: { ...taskRef } }).kind).toBe("hold");
    expect(holdOf({ mission: execWith({ admissions: [] }), scope: { ...SCOPE }, completion: { ...taskRef } }).reason).toBe("unresolved_source");
    expect(holdOf({ mission: execWith({ admissions: [admissionFixture(), admissionFixture({ dispatchKey: "dispatch-2" })] }), scope: { ...SCOPE }, completion: { ...taskRef } }).reason).toBe("ambiguous_completion");
  });

  it("denies duplicate keyed results even when only one provenance matches", () => {
    const other = resultRecordFixture({ provenance: { ...resultRecordFixture().provenance, childRunId: "run:other" } });
    expect(holdOf({ mission: execWith({ results: [resultRecordFixture(), other] }), scope: { ...SCOPE }, completion: { ...taskRef } }).reason).toBe("ambiguous_completion");
    expect(holdOf({ mission: execWith({ results: [resultRecordFixture(), resultRecordFixture()] }), scope: { ...SCOPE }, completion: { ...taskRef } }).reason).toBe("ambiguous_completion");
  });

  it("holds revision/run/hash drift", () => {
    const mission = missionFixture();
    expect(holdOf({ mission, scope: { ...SCOPE }, completion: { ...taskRef, childRunId: "run:drifted" } }).reason).toBe("source_mismatch");
    expect(holdOf({ mission, scope: { ...SCOPE }, completion: { ...taskRef, resultRevision: 6 } }).reason).toBe("source_mismatch");
    expect(holdOf({ mission, scope: { ...SCOPE }, completion: { ...retroRef, normalizedReportHash: hex("ff") } }).reason).toBe("source_mismatch");
  });

  it("holds same-ID checkpoint or analysis whose full source tuple is foreign", () => {
    expect(resolveCompletionRoute({ mission: execWith({ retroCheckpoints: [checkpointFixture({ teamId: "foreign", snapshotFingerprint: hex("ee") })] }), scope: { ...SCOPE }, completion: { ...retroRef } }).kind).toBe("hold");
    expect(resolveCompletionRoute({ mission: execWith({ retroAnalyses: [analysisFixture({ teamId: "foreign" })] }), scope: { ...SCOPE }, completion: { ...retroRef } }).kind).toBe("hold");
  });

  it("holds queued analysis with null lease and lease token mismatch as not genuine", () => {
    const queued = decodeAnalysis({
      checkpointId: "chk-1", teamId: "team-1", environmentId: "env-1", missionId: "mission-1",
      sourceThreadId: SOURCE_THREAD, sourceRoot: SOURCE_ROOT, snapshotFingerprint: FP,
      coveredFromInclusive: 0, coveredToExclusive: 10, managerThreadId: "thread-retro",
      managerEpoch: 1, status: "queued_capacity", queueReason: "capacity", fence: 0, attemptNumber: 0, lease: null, settlement: null,
    });
    expect(holdOf({ mission: execWith({ retroAnalyses: [queued] }), scope: { ...SCOPE }, completion: { ...retroRef } }).reason).toBe("unresolved_source");
    const badLease = analysisFixture({ lease: { ...leaseFixture(), assignmentToken: hex("99") } });
    expect(holdOf({ mission: execWith({ retroAnalyses: [badLease] }), scope: { ...SCOPE }, completion: { ...retroRef } }).reason).toBe("source_mismatch");
  });

  it("denies duplicate checkpoint and analysis ID collisions", () => {
    expect(holdOf({ mission: execWith({ retroCheckpoints: [checkpointFixture(), checkpointFixture()] }), scope: { ...SCOPE }, completion: { ...retroRef } }).reason).toBe("ambiguous_completion");
    const base = missionFixture();
    const dupAnalyses = { ...base, execution: { ...base.execution, retroAnalyses: [analysisFixture(), analysisFixture()] } } as unknown as Mission;
    expect(holdOf({ mission: dupAnalyses, scope: { ...SCOPE }, completion: { ...retroRef } }).reason).toBe("ambiguous_completion");
  });

  it("holds unresolved retro when checkpoint or analysis is missing", () => {
    expect(holdOf({ mission: execWith({ retroCheckpoints: [] }), scope: { ...SCOPE }, completion: { ...retroRef } }).reason).toBe("unresolved_source");
    expect(holdOf({ mission: execWith({ retroAnalyses: [] }), scope: { ...SCOPE }, completion: { ...retroRef } }).reason).toBe("unresolved_source");
  });

  it("holds non-active missions and denies scope mismatch", () => {
    for (const status of ["paused", "completed", "stopped"] as const) {
      expect(holdOf({ mission: missionFixture({ status }), scope: { ...SCOPE }, completion: { ...taskRef } }).reason).toBe("mission_inactive");
    }
    const mission = missionFixture();
    for (const scope of [{ ...SCOPE, teamId: "team-foreign" }, { ...SCOPE, environmentId: "env-foreign" }, { ...SCOPE, missionId: "mission-foreign" }]) {
      expect(holdOf({ mission, scope, completion: { ...taskRef } }).reason).toBe("scope_mismatch");
    }
  });

  it("holds malformed persisted rows and null execution without throwing", () => {
    const mission = missionFixture();
    const cases: Array<unknown> = [
      { ...mission, execution: { ...mission.execution, results: [null] } },
      { ...mission, execution: { ...mission.execution, retroReportReceipts: [null] } },
      { ...mission, execution: { ...mission.execution, retroCheckpoints: [null] } },
      { ...mission, execution: { ...mission.execution, retroAnalyses: [null] } },
      { ...mission, execution: { ...mission.execution, admissions: [null] } },
      { ...mission, execution: null },
      { ...mission, execution: "legacy" },
      { ...mission, execution: { ...mission.execution, results: "nope" } },
    ];
    for (const m of cases) {
      expect(() => resolveCompletionRoute({ mission: m as never, scope: { ...SCOPE }, completion: { ...taskRef } })).not.toThrow();
      expect(resolveCompletionRoute({ mission: m as never, scope: { ...SCOPE }, completion: { ...taskRef } }).kind).toBe("hold");
      expect(resolveCompletionRoute({ mission: m as never, scope: { ...SCOPE }, completion: { ...retroRef } }).kind).toBe("hold");
    }
  });

  it("rejects null, extra-key, control, path, URL, oversize, and unsafe inputs", () => {
    const mission = missionFixture();
    expect(resolveCompletionRoute(null as unknown as ResolveCompletionRouteInput).kind).toBe("hold");
    const bad: Array<unknown> = [
      { ...taskRef, extraBody: "x" },
      { ...taskRef, taskId: "" },
      { ...taskRef, attemptNumber: 1.5 },
      { ...taskRef, resultRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...taskRef, childThreadId: "thread:bad\nid" },
      { ...taskRef, childThreadId: `thread:${"a".repeat(600)}` },
      { ...taskRef, childTaskId: "a".repeat(129) },
      { ...taskRef, childThreadId: "https://evil.example/x?y=1" },
      { ...retroRef, sourceRoot: "/tmp/path" },
      { ...retroRef, sourceRoot: "https://evil.example" },
      { ...retroRef, normalizedReportHash: "not-a-hash" },
      { ...retroRef, reportRevision: 0 },
    ];
    for (const completion of bad) {
      const d = resolveCompletionRoute({ mission, scope: { ...SCOPE }, completion: completion as never });
      expect(d.kind).toBe("hold");
      if (d.kind === "hold") expect(d.reason).toBe("malformed_input");
    }
  });

  it("does not mutate inputs and returns frozen metadata-only output", () => {
    const input: ResolveCompletionRouteInput = { mission: missionFixture(), scope: { ...SCOPE }, completion: { ...taskRef } };
    const before = stableStringify(input);
    const d = resolveCompletionRoute(input);
    expect(stableStringify(input)).toBe(before);
    expect(Object.isFrozen(d)).toBe(true);
    if (d.kind === "candidate") {
      expect(Object.isFrozen(d.candidate)).toBe(true);
      expect(Object.isFrozen(d.candidate.source)).toBe(true);
      expect(Object.isFrozen(d.candidate.scope)).toBe(true);
    }
  });
});

describe("root completion route regressions", () => {
  it("rejects currentness after same-revision pause or scope replacement", () => {
    const mission = missionFixture();
    const candidate = candidateOf({ mission, scope: SCOPE, completion: taskRef });
    expect(isCompletionCandidateCurrent(missionFixture({ status: "paused" }), candidate)).toBe(false);
    expect(isCompletionCandidateCurrent(missionFixture({ teamId: "foreign" }), candidate)).toBe(false);
  });
  it("holds malformed persisted rows instead of throwing", () => {
    const mission = missionFixture();
    const malformed = { ...mission, execution: { ...mission.execution, results: [null] } } as unknown as Mission;
    expect(() => resolveCompletionRoute({ mission: malformed, scope: SCOPE, completion: taskRef })).not.toThrow();
    expect(resolveCompletionRoute({ mission: malformed, scope: SCOPE, completion: taskRef }).kind).toBe("hold");
  });
  it("holds a same-ID checkpoint whose authoritative source tuple is foreign", () => {
    const mission = missionFixture();
    const drifted = missionFixture({ execution: { ...mission.execution, retroCheckpoints: [checkpointFixture({ teamId: "foreign", snapshotFingerprint: hex("ee") })] } });
    expect(resolveCompletionRoute({ mission: drifted, scope: SCOPE, completion: retroRef }).kind).toBe("hold");
  });
  it("holds a completion whose task is absent from the canonical mission", () => {
    expect(resolveCompletionRoute({ mission: missionFixture({ tasks: [] }), scope: SCOPE, completion: taskRef }).kind).toBe("hold");
  });
});


it("does not treat missing Retro lease and receipt proof fields as equal evidence", () => {
  const mission = missionFixture();
  const analysis = analysisFixture();
  const receipt = receiptFixture();
  const lease = { ...analysis.lease };
  const badReceipt = { ...receipt };
  for (const key of ["assignmentToken", "accountId", "providerInstanceId", "modelId", "profile"] as const) {
    delete (lease as Record<string, unknown>)[key];
    delete (badReceipt as unknown as Record<string, unknown>)[key];
  }
  const malformed = { ...mission, execution: { ...mission.execution, retroAnalyses: [{ ...analysis, lease }], retroReportReceipts: [badReceipt] } } as unknown as Mission;
  expect(resolveCompletionRoute({ mission: malformed, scope: SCOPE, completion: retroRef }).kind).toBe("hold");
});
