// @effect-diagnostics nodeBuiltinImport:off -- test hashes bind artifact bytes.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, EnvironmentId, Mission, MissionId, TeamId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { Mission as MissionValue } from "../../../../packages/contracts/src/mission.ts";
import type { MissionRetroAnalysisLease as LeaseValue } from "../../../../packages/contracts/src/missionRetroAnalysis.ts";
import type {
  MissionRetroReport as ReportValue,
  MissionRetroReportIncident as IncidentValue,
} from "../../../../packages/contracts/src/missionRetroReport.ts";
import type { MissionRetroSourceRef as SourceRefValue } from "../../../../packages/contracts/src/missionRetro.ts";
import * as Analysis from "./MissionRetroAnalysisStore.ts";
import * as Checkpoints from "./MissionRetroCheckpointStore.ts";
import * as MissionService from "./MissionService.ts";
import * as ReportStore from "./MissionRetroReportStore.ts";
import {
  computeRetroReportHash,
  withActualReportHash,
  type MissionRetroReportTrustedCoverage,
} from "./MissionRetroReportReconciliation.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";

const delivery = {
  teamId: TeamId.make("team"),
  environmentId: EnvironmentId.make("env"),
  controllerThreadId: ThreadId.make("delivery"),
};
const retro = { ...delivery, controllerThreadId: ThreadId.make("retro") };
const AUTHORITY = { source: "mission-council", ref: "decision" };
const baseCommit = "a".repeat(40);
const FINGERPRINT = "a".repeat(64);
const decodeFixture = Schema.decodeSync(Mission);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(Mission));
const sha = (text: string): string => NodeCrypto.createHash("sha256").update(text).digest("hex");

const fixture = (id: string): MissionValue =>
  decodeFixture({
    schemaVersion: 1,
    id,
    revision: 0,
    teamId: "team",
    authorityEnvironmentId: "env",
    bindings: [
      { projectId: "project", workspaceRoot: "/tmp/project", baseCommit, ancestry: [baseCommit] },
    ],
    intent: {
      outcome: "Analyze",
      scope: ["retro"],
      exclusions: [],
      authorityRefs: [AUTHORITY],
      acceptanceCriteria: [{ id: "ac", text: "Once" }],
      decisions: [],
    },
    integrationTarget: { summary: "Root" },
    managers: {
      delivery: { threadId: "delivery", epoch: 3 },
      retro: { threadId: "retro", epoch: 4 },
    },
    status: "active",
    tasks: [
      {
        id: "task",
        projectId: "project",
        title: "Task",
        specHash: "spec",
        dependencyHashes: [],
        dependencies: [],
        acceptanceIds: ["ac"],
        updatedAt: "2026-10-14T00:00:00.000Z",
      },
    ],
    updatedAt: "2026-10-14T00:00:00.000Z",
  });

const chunkFor = (from: number, to: number): SourceRefValue => ({
  rootRef: "thread://origin",
  chunkRef: `chunk-${from}-${to}`,
  chunkHash: "b".repeat(64),
  coveredFromInclusive: from,
  coveredToExclusive: to,
});

type TerminalStatus = "succeeded" | "failed" | "cancelled" | "not_started";

interface HarnessOpts {
  readonly coverage?: Partial<MissionRetroReportTrustedCoverage>;
  readonly failReceipts?: boolean;
  readonly tamperNormalizedSha?: boolean;
  /** Return descriptor bytes for a DIFFERENT report than the server normalized. */
  readonly normalizedOverride?: (report: ReportValue) => ReportValue;
  readonly gate?: Deferred.Deferred<void>;
  readonly entered?: Deferred.Deferred<void>;
  readonly actualOrigin?: string;
  readonly capacityReady?: boolean;
  readonly foreignOriginalScope?: boolean;
}

interface Harness {
  readonly base: Layer.Layer<ReportStore.MissionRetroReportStore | Analysis.MissionRetroAnalysisStore |
    Checkpoints.MissionRetroCheckpointStore | MissionService.MissionService |
    Events.OrchestrationEventStore | Receipts.OrchestrationCommandReceiptRepository, never, SqlClient.SqlClient>;
  readonly calls: { read: number; prepare: number };
  readonly originals: Map<string, string>;
  readonly normalized: Map<string, string>;
  readonly coverageEvidence: Map<string, string>;
  readonly terminal: { status: TerminalStatus };
}

const harness = (opts: HarnessOpts = {}): Harness => {
  const calls = { read: 0, prepare: 0 };
  const originals = new Map<string, string>();
  const normalized = new Map<string, string>();
  const coverageEvidence = new Map<string, string>();
  const terminal: { status: TerminalStatus } = { status: "succeeded" };
  const receiptLayer = Layer.effect(
    Receipts.OrchestrationCommandReceiptRepository,
    Effect.gen(function* () {
      const real = yield* Receipts.OrchestrationCommandReceiptRepository;
      return {
        insertIfAbsent: (receipt: Receipts.OrchestrationCommandReceipt) =>
          opts.failReceipts &&
          receipt.commandType === ReportStore.MISSION_RETRO_REPORT_RECEIVE_COMMAND_TYPE
            ? Effect.succeed(false)
            : real.insertIfAbsent(receipt),
        upsert: real.upsert,
        getByCommandId: real.getByCommandId,
      };
    }),
  ).pipe(Layer.provide(Receipts.layer));
  const authorityDelivery = Layer.succeed(MissionService.MissionAuthority, delivery);
  const snapshot = Layer.succeed(Checkpoints.MissionRetroSnapshotPort, {
    readSnapshot: (cmd: Checkpoints.MissionRetroCaptureCommand) =>
      Effect.gen(function* () {
        return {
          teamId: "team",
          environmentId: "env",
          deliveryThreadId: "delivery",
          deliveryEpoch: 3,
          nowMs: yield* Clock.currentTimeMillis,
          missionId: cmd.missionId,
          sourceRoot: "thread://origin",
          sourceThreadId: "origin",
          actualOrigin: "product",
          eligibleTrigger: "milestone",
          fromInclusive: cmd.fromInclusive,
          toExclusive: cmd.toExclusive,
          snapshotFingerprint: FINGERPRINT,
          sourceRefs: [],
          omissions: [],
          coverage: "unknown" as const,
          pendingChildRuns: false,
          capacity: {
            state: "unknown" as const,
            accountId: null,
            company: null,
            reporterIdentity: null,
            exhausted: false,
            lowReserve: false,
            profile: null,
          },
        };
      }),
  });
  const analysisPort = Layer.succeed(Analysis.MissionRetroAnalysisFactsPort, {
    readClaimFacts: (
      cmd: Analysis.MissionRetroAnalysisClaimCommand,
      cp: Analysis.MissionRetroAnalysisCheckpoint,
    ) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const readyNow = opts.capacityReady ?? true;
        return {
          teamId: "team",
          environmentId: "env",
          missionId: cmd.missionId,
          checkpointId: cp.checkpointId,
          retroThreadId: "retro",
          retroEpoch: 4,
          sourceThreadId: cp.sourceThreadId,
          sourceRoot: cp.sourceRoot,
          snapshotFingerprint: cp.snapshotFingerprint,
          coveredFromInclusive: cp.coveredFromInclusive,
          coveredToExclusive: cp.coveredToExclusive,
          nowMs,
          maxFactAgeMs: 1000,
          leaseDurationMs: 100000,
          capacity: {
            ready: readyNow,
            exhausted: false,
            lowReserve: false,
            verified: true,
            company: "No Fun",
            accountId: "account",
            providerInstanceId: "muse-personal" as const,
            modelId: "muse-spark-1.3-contributor",
            profile: "muse-review",
            observedAtMs: nowMs,
            accountRef: "account-ref",
            providerRef: "provider-ref",
            capacityRef: "capacity-ref",
          },
          host: {
            hostId: "host",
            bootId: "boot",
            verified: true,
            interactivePressureVerified: true,
            pressureReady: true,
            buildVerified: true,
            productiveWorkPriority: true,
            observedAtMs: nowMs,
            hostRef: "host-ref",
            buildRef: "build-ref",
            priorityRef: "priority-ref",
          },
          prepared: {
            reporterChildThreadId: `child-${cmd.missionId}`,
            reporterRunId: `run-${cmd.missionId}`,
            verified: true,
            receiptRef: "prepared-ref",
          },
        };
      }),
    readTerminalFacts: (cmd: Analysis.MissionRetroAnalysisSettleCommand) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        return {
          teamId: "team",
          environmentId: "env",
          missionId: cmd.missionId,
          checkpointId: cmd.checkpointId,
          retroThreadId: "retro",
          retroEpoch: 4,
          nowMs,
          maxFactAgeMs: 1000,
          binding: {
            assignmentToken: cmd.assignmentToken,
            fence: cmd.fence,
            attemptNumber: cmd.attemptNumber,
            reporterChildThreadId: cmd.reporterChildThreadId,
            reporterRunId: cmd.reporterRunId,
            hostId: cmd.hostId,
            bootId: cmd.bootId,
          },
          verified: true,
          status: terminal.status,
          receiptRef: "terminal-ref",
          observedAtMs: nowMs,
        };
      }),
  });
  const reportPort = Layer.succeed(ReportStore.MissionRetroReportArtifactPort, {
    readOriginal: (input: ReportStore.MissionRetroReportReadInput) =>
      Effect.gen(function* () {
        calls.read++;
        if (opts.entered) yield* Deferred.succeed(opts.entered, undefined);
        if (opts.gate) yield* Deferred.await(opts.gate);
        const bytes = originals.get(input.command.originalArtifactRef);
        if (bytes === undefined)
          return yield* new ReportStore.MissionRetroReportStoreError({
            operation: "receive",
            category: "persistence",
          });
        const report = decodeJson(bytes) as ReportValue;
        const chunk = chunkFor(report.coveredFromInclusive, report.coveredToExclusive);
        const coverage: MissionRetroReportTrustedCoverage = {
          manifestSourceRefs: [chunk],
          readReceipts: [chunk],
          apiCoverage: "full",
          childLogCoverage: "full",
          rawStdoutCoverage: "full",
          pendingChildRuns: false,
          trustedSkillLoads: [],
          ...opts.coverage,
        };
        return {
          teamId: opts.foreignOriginalScope ? "other-team" : "team",
          environmentId: "env",
          missionId: input.command.missionId,
          checkpointId: input.command.checkpointId,
          retroThreadId: "retro",
          retroEpoch: 4,
          sourceThreadId: "origin",
          sourceRoot: "thread://origin",
          snapshotFingerprint: FINGERPRINT,
          coveredFromInclusive: report.coveredFromInclusive,
          coveredToExclusive: report.coveredToExclusive,
          originalArtifactRef: input.command.originalArtifactRef,
          descriptorBytes: bytes,
          report,
          actualOrigin: opts.actualOrigin ?? "product",
          coverage,
        };
      }),
    prepareNormalized: (input: ReportStore.MissionRetroReportPrepareInput) =>
      Effect.sync(() => {
        calls.prepare++;
        const effective = opts.normalizedOverride ? opts.normalizedOverride(input.report) : input.report;
        const bytes = stableStringify(effective);
        const artifactRef = `retro-normalized:${effective.reportHash}`;
        normalized.set(artifactRef, bytes);
        const evidenceBytes = stableStringify(input.coverageEvidence);
        const evidenceSha = sha(evidenceBytes);
        const evidenceRef = "retro-coverage:" + evidenceSha;
        coverageEvidence.set(evidenceRef, evidenceBytes);
        return {
          artifactRef,
          coverageEvidence: { artifactRef: evidenceRef, artifactSha: evidenceSha, descriptorBytes: evidenceBytes },
          artifactSha: opts.tamperNormalizedSha ? "0".repeat(64) : sha(bytes),
          descriptorBytes: bytes,
        };
      }),
  });
  const base = Layer.mergeAll(
    ReportStore.layer.pipe(
      Layer.provide(Events.layer),
      Layer.provide(receiptLayer),
      Layer.provide(Layer.succeed(MissionService.MissionAuthority, retro)),
      Layer.provide(reportPort),
    ),
    Analysis.layer.pipe(
      Layer.provide(Events.layer),
      Layer.provide(receiptLayer),
      Layer.provide(Layer.succeed(MissionService.MissionAuthority, retro)),
      Layer.provide(analysisPort),
    ),
    Checkpoints.layer.pipe(
      Layer.provide(Events.layer),
      Layer.provide(receiptLayer),
      Layer.provide(authorityDelivery),
      Layer.provide(snapshot),
    ),
    MissionService.layer.pipe(
      Layer.provide(Events.layer),
      Layer.provide(receiptLayer),
      Layer.provide(authorityDelivery),
    ),
    Events.layer,
    receiptLayer,
  );
  return { base, calls, originals, normalized, coverageEvidence, terminal };
};

const memory = (h: Harness) => h.base.pipe(Layer.provideMerge(Sqlite.layerMemory));

const ok = <A, E>(result: Result.Result<A, E>): A => {
  assert.isTrue(Result.isSuccess(result), "expected success result");
  if (Result.isSuccess(result)) return result.success;
  throw new Error("unreachable");
};
const errCode = <A, E>(result: Result.Result<A, E>): string => {
  assert.isTrue(Result.isFailure(result), "expected failure result");
  if (Result.isFailure(result)) {
    const failure: unknown = result.failure;
    if (typeof failure === "object" && failure !== null) {
      const record = failure as { readonly code?: unknown; readonly category?: unknown };
      if (typeof record.code === "string") return record.code;
      if (typeof record.category === "string") return record.category;
    }
  }
  throw new Error("failure without code");
};

interface Seeded {
  readonly checkpointId: string;
  readonly lease: LeaseValue;
  readonly fence: number;
  readonly attemptNumber: number;
}

const seedClaim = (id = "mission", from = 1, to = 2) =>
  Effect.gen(function* () {
    const svc = yield* MissionService.MissionService;
    yield* svc.execute({
      type: "mission.create",
      commandId: CommandId.make(`create-${id}`),
      mission: fixture(id),
    });
    const caps = yield* Checkpoints.MissionRetroCheckpointStore;
    const captured = ok(
      yield* caps.capture({
        commandId: CommandId.make(`capture-${id}-${from}`),
        missionId: id,
        expectedRevision: 0,
        deliveryEpoch: 3,
        sourceThreadId: "origin",
        fromInclusive: from,
        toExclusive: to,
        trigger: "milestone",
      }),
    );
    const store = yield* Analysis.MissionRetroAnalysisStore;
    const claimed = ok(
      yield* store.claim({
        commandId: CommandId.make(`claim-${id}-${from}`),
        missionId: id,
        checkpointId: captured.checkpoint.checkpointId,
        expectedRevision: 1,
        retroEpoch: 4,
      }),
    );
    const lease = claimed.analysis.lease;
    assert.isNotNull(lease, "claim must produce a lease");
    if (lease === null) throw new Error("unreachable");
    return {
      checkpointId: captured.checkpoint.checkpointId,
      lease,
      fence: claimed.analysis.fence,
      attemptNumber: claimed.analysis.attemptNumber,
    } satisfies Seeded;
  });

const seedCaptureOnly = (id = "mission") =>
  Effect.gen(function* () {
    const svc = yield* MissionService.MissionService;
    yield* svc.execute({
      type: "mission.create",
      commandId: CommandId.make(`create-${id}`),
      mission: fixture(id),
    });
    const caps = yield* Checkpoints.MissionRetroCheckpointStore;
    return ok(
      yield* caps.capture({
        commandId: CommandId.make(`capture-${id}`),
        missionId: id,
        expectedRevision: 0,
        deliveryEpoch: 3,
        sourceThreadId: "origin",
        fromInclusive: 1,
        toExclusive: 2,
        trigger: "milestone",
      }),
    ).checkpoint.checkpointId;
  });

type ReportOverrides = Partial<Omit<ReportValue, "reportHash">>;

const reportFor = (
  missionId: string,
  seeded: Seeded,
  from = 1,
  to = 2,
  over: ReportOverrides = {},
): ReportValue =>
  withActualReportHash({
    checkpointId: seeded.checkpointId,
    teamId: "team",
    environmentId: "env",
    missionId,
    sourceThreadId: "origin",
    sourceRoot: "thread://origin",
    snapshotFingerprint: FINGERPRINT,
    coveredFromInclusive: from,
    coveredToExclusive: to,
    reporterChildThreadId: seeded.lease.reporterChildThreadId,
    reporterRunId: seeded.lease.reporterRunId,
    reportRevision: seeded.lease.reportRevision,
    assignmentToken: seeded.lease.assignmentToken,
    managerEpoch: 4,
    model: "muse-spark-1.3-contributor",
    profile: "muse-review",
    sourceRefs: [chunkFor(from, to)],
    claimedReadRefs: [],
    summary: "summary",
    verdict: "no_change",
    shortlist: [],
    incidents: [],
    skillEvidence: [],
    omissions: [],
    ...over,
  });

interface Staged {
  readonly ref: string;
  readonly sha: string;
  readonly claimed: string;
  readonly bytes: string;
}

const stage = (h: Harness, report: ReportValue, ref = "retro-original:1"): Staged => {
  const bytes = stableStringify(report);
  h.originals.set(ref, bytes);
  return { ref, sha: sha(bytes), claimed: computeRetroReportHash(report), bytes };
};

const cmdFor = (
  missionId: string,
  checkpointId: string,
  staged: Staged,
  commandId = "receive-1",
  expectedRevision = 2,
  over: Partial<ReportStore.MissionRetroReportReceiveCommand> = {},
): ReportStore.MissionRetroReportReceiveCommand => ({
  commandId: CommandId.make(commandId),
  missionId,
  checkpointId,
  expectedRevision,
  retroEpoch: 4,
  originalArtifactRef: staged.ref,
  originalArtifactSha: staged.sha,
  claimedSourceReportHash: staged.claimed,
  ...over,
});

const current = (id = "mission") =>
  Effect.gen(function* () {
    return Option.getOrThrow(yield* (yield* MissionService.MissionService).get(MissionId.make(id)));
  });

const reportEvents = (id = "mission") =>
  Effect.gen(function* () {
    const logged = yield* (yield* Events.OrchestrationEventStore).readMissionEvents(
      MissionId.make(id),
    );
    return logged.filter((entry) => entry.type === "mission.retro-report-received");
  });

const receiptsOf = (mission: MissionValue) => mission.execution?.retroReportReceipts ?? [];

const normalizedReport = (h: Harness, ref: string): ReportValue => {
  const bytes = h.normalized.get(ref);
  assert.isDefined(bytes, `normalized artifact ${ref} must exist`);
  return JSON.parse(bytes as string) as ReportValue;
};

const settle = (id: string, seeded: Seeded, commandId: string, expectedRevision: number) =>
  Effect.gen(function* () {
    const store = yield* Analysis.MissionRetroAnalysisStore;
    return yield* store.settle({
      commandId: CommandId.make(commandId),
      missionId: id,
      checkpointId: seeded.checkpointId,
      expectedRevision,
      retroEpoch: 4,
      assignmentToken: seeded.lease.assignmentToken,
      fence: seeded.fence,
      attemptNumber: seeded.attemptNumber,
      reporterChildThreadId: seeded.lease.reporterChildThreadId,
      reporterRunId: seeded.lease.reporterRunId,
      hostId: seeded.lease.hostId,
      bootId: seeded.lease.bootId,
    });
  });

it.effect("valid full no_change persists pointer, event and receipt once", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const staged = stage(h, reportFor("mission", seeded));
      const store = yield* ReportStore.MissionRetroReportStore;
      const out = ok(yield* store.receive(cmdFor("mission", seeded.checkpointId, staged)));
      assert.isTrue(out.committed);
      assert.strictEqual(out.disposition, "queued_for_triage");
      assert.strictEqual(out.receiptRecord.verdict, "no_change");
      assert.strictEqual(out.sourceReportHash, staged.claimed);
      assert.strictEqual(out.receiptRecord.originalArtifactSha, staged.sha);
      const mission = yield* current();
      const records = receiptsOf(mission);
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0]?.normalizedArtifactRef, out.normalizedArtifactRef);
      assert.strictEqual((yield* reportEvents()).length, 1);
      // Snapshot stays pointer-sized: no report body text is persisted.
      assert.isFalse(stableStringify(mission).includes('"summary":"summary"'));
      assert.strictEqual(normalizedReport(h, out.normalizedArtifactRef).verdict, "no_change");
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("candidate dedup keeps complete index linked and source/normalized hashes distinct", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const first: IncidentValue = {
        incidentId: "incident:1",
        concernId: "concern:1",
        sourceEventRef: "event:1",
        summary: "s",
        destinationOwner: "project_guidance",
      };
      const duplicate: IncidentValue = { ...first, incidentId: "incident:1-dup" };
      const other: IncidentValue = {
        incidentId: "incident:2",
        concernId: "concern:2",
        sourceEventRef: "event:2",
        summary: "s2",
        destinationOwner: "task_recovery",
      };
      const report = reportFor("mission", seeded, 1, 2, {
        verdict: "candidates",
        incidents: [first, duplicate, other],
        shortlist: [
          {
            candidateId: "candidate:1",
            concernId: "concern:1",
            incidentRefs: ["incident:1", "incident:2"],
            summary: "c",
            destinationOwner: "project_guidance",
            alreadyFixed: false,
          },
        ],
      });
      const staged = stage(h, report);
      const store = yield* ReportStore.MissionRetroReportStore;
      const out = ok(yield* store.receive(cmdFor("mission", seeded.checkpointId, staged)));
      assert.strictEqual(out.disposition, "queued_for_triage");
      assert.strictEqual(out.receiptRecord.incidentCount, 2);
      assert.strictEqual(out.receiptRecord.shortlistCount, 1);
      assert.notStrictEqual(out.sourceReportHash, out.normalizedReportHash);
      assert.strictEqual(out.receiptRecord.incidentArtifactRef, out.normalizedArtifactRef);
      const normalized = normalizedReport(h, out.normalizedArtifactRef);
      assert.strictEqual(normalized.incidents.length, 2);
      assert.deepStrictEqual(
        normalized.shortlist[0]?.incidentRefs,
        ["incident:1", "incident:2"],
      );
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("partial zero findings stays held without triage or effectiveness", () =>
  Effect.gen(function* () {
    const h = harness({ coverage: { readReceipts: [] } });
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const staged = stage(h, reportFor("mission", seeded));
      const store = yield* ReportStore.MissionRetroReportStore;
      const out = ok(yield* store.receive(cmdFor("mission", seeded.checkpointId, staged)));
      assert.strictEqual(out.disposition, "held_partial");
      assert.strictEqual(out.receiptRecord.verdict, "partial_coverage");
      assert.isFalse(out.receiptRecord.coverageFull);
      assert.isTrue(out.receiptRecord.coverageReasonRefs.length > 0);
      assert.isTrue(out.receiptRecord.coverageReasonRefs.length <= 8);
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("forged worker skill and coverage claims remain unknown in the normalized artifact", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const report = reportFor("mission", seeded, 1, 2, {
        skillEvidence: [
          {
            skillPath: "skills/x/SKILL.md",
            observedRevision: "b".repeat(64),
            expectedApplicability: "applicable",
            discovery: "installed",
            invocation: "native_invoked",
            application: "applied",
            outcome: "success_behavior",
          },
        ],
      });
      const staged = stage(h, report);
      const store = yield* ReportStore.MissionRetroReportStore;
      const out = ok(yield* store.receive(cmdFor("mission", seeded.checkpointId, staged)));
      const normalized = normalizedReport(h, out.normalizedArtifactRef);
      assert.strictEqual(normalized.skillEvidence[0]?.invocation, "unknown");
      assert.strictEqual(normalized.skillEvidence[0]?.discovery, "unknown");
      assert.strictEqual(normalized.skillEvidence[0]?.application, "unknown");
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("foreign fingerprint is held quarantined, never queued", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const report = reportFor("mission", seeded, 1, 2, {
        snapshotFingerprint: "c".repeat(64),
      });
      const staged = stage(h, report);
      const store = yield* ReportStore.MissionRetroReportStore;
      const out = ok(yield* store.receive(cmdFor("mission", seeded.checkpointId, staged)));
      assert.strictEqual(out.disposition, "held_quarantined");
      assert.strictEqual(out.receiptRecord.disposition, "held_quarantined");
      assert.strictEqual(out.receiptRecord.verdict, "partial_coverage");
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("alias command dedups and alias replay repeats the saved outcome", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const staged = stage(h, reportFor("mission", seeded));
      const store = yield* ReportStore.MissionRetroReportStore;
      const first = ok(yield* store.receive(cmdFor("mission", seeded.checkpointId, staged)));
      const revision = (yield* current()).revision;
      const aliasCmd = cmdFor("mission", seeded.checkpointId, staged, "receive-alias", 999);
      const alias = ok(yield* store.receive(aliasCmd));
      assert.isFalse(alias.committed);
      assert.deepStrictEqual(alias.receiptRecord, first.receiptRecord);
      assert.strictEqual(alias.eventSequence, first.eventSequence);
      assert.strictEqual((yield* current()).revision, revision);
      assert.strictEqual((yield* reportEvents()).length, 1);
      const again = ok(yield* store.receive(aliasCmd));
      assert.deepStrictEqual(again.receiptRecord, first.receiptRecord);
      assert.strictEqual(again.eventSequence, first.eventSequence);
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("concurrent alias commands commit exactly one event and revision", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const staged = stage(h, reportFor("mission", seeded));
      const store = yield* ReportStore.MissionRetroReportStore;
      const left = yield* Effect.forkChild(
        store.receive(cmdFor("mission", seeded.checkpointId, staged, "receive-left")),
      );
      const right = yield* Effect.forkChild(
        store.receive(cmdFor("mission", seeded.checkpointId, staged, "receive-right")),
      );
      const a = ok(yield* Fiber.join(left));
      const b = ok(yield* Fiber.join(right));
      assert.strictEqual(a.eventSequence, b.eventSequence);
      assert.deepStrictEqual(a.receiptRecord, b.receiptRecord);
      assert.isTrue(a.committed !== b.committed);
      assert.strictEqual((yield* reportEvents()).length, 1);
      assert.strictEqual(receiptsOf(yield* current()).length, 1);
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("changed actual source quarantines on the original receipt and replays exactly", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const staged = stage(h, reportFor("mission", seeded));
      const store = yield* ReportStore.MissionRetroReportStore;
      const first = ok(yield* store.receive(cmdFor("mission", seeded.checkpointId, staged)));
      const changed = reportFor("mission", seeded, 1, 2, { summary: "changed" });
      const staged2 = stage(h, changed, "retro-original:2");
      const conflictCmd = cmdFor(
        "mission",
        seeded.checkpointId,
        staged2,
        "receive-2",
        (yield* current()).revision,
      );
      const held = ok(yield* store.receive(conflictCmd));
      assert.strictEqual(held.disposition, "held_conflict");
      assert.strictEqual(held.sourceReportHash, staged2.claimed);
      const records = receiptsOf(yield* current());
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0]?.sourceReportHash, first.sourceReportHash);
      assert.strictEqual(records[0]?.disposition, "queued_for_triage");
      assert.strictEqual(records[0]?.quarantine.length, 1);
      assert.strictEqual(records[0]?.quarantine[0]?.sourceReportHash, staged2.claimed);
      const replay = ok(yield* store.receive(conflictCmd));
      assert.isFalse(replay.committed);
      assert.strictEqual(replay.disposition, "held_conflict");
      assert.strictEqual(replay.eventSequence, held.eventSequence);
      const revision = (yield* current()).revision;
      const repeated = ok(
        yield* store.receive(
          cmdFor("mission", seeded.checkpointId, staged2, "receive-3", 999),
        ),
      );
      assert.strictEqual(repeated.disposition, "held_conflict");
      assert.strictEqual((yield* current()).revision, revision);
      assert.strictEqual(receiptsOf(yield* current())[0]?.quarantine.length, 1);
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("quarantine bound denies the fifth variant without dropping history", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const staged = stage(h, reportFor("mission", seeded));
      const store = yield* ReportStore.MissionRetroReportStore;
      ok(yield* store.receive(cmdFor("mission", seeded.checkpointId, staged)));
      for (let i = 1; i <= 4; i++) {
        const variant = stage(
          h,
          reportFor("mission", seeded, 1, 2, { summary: `variant-${i}` }),
          `retro-original:v${i}`,
        );
        const out = ok(
          yield* store.receive(
            cmdFor("mission", seeded.checkpointId, variant, `receive-v${i}`, (yield* current()).revision),
          ),
        );
        assert.strictEqual(out.disposition, "held_conflict");
      assert.strictEqual(out.verdict, "partial_coverage");
      }
      assert.strictEqual(receiptsOf(yield* current())[0]?.quarantine.length, 4);
      const fifth = stage(
        h,
        reportFor("mission", seeded, 1, 2, { summary: "variant-5" }),
        "retro-original:v5",
      );
      const denied = yield* store.receive(
        cmdFor("mission", seeded.checkpointId, fifth, "receive-v5", (yield* current()).revision),
      );
      assert.strictEqual(errCode(denied), "quarantine_bound");
      assert.strictEqual(receiptsOf(yield* current())[0]?.quarantine.length, 4);
      assert.strictEqual(receiptsOf(yield* current())[0]?.disposition, "queued_for_triage");
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("misclaimed source hash is held as conflict and never queued", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const staged = stage(h, reportFor("mission", seeded));
      const store = yield* ReportStore.MissionRetroReportStore;
      const out = ok(
        yield* store.receive(
          cmdFor("mission", seeded.checkpointId, staged, "receive-1", 2, {
            claimedSourceReportHash: "0".repeat(64),
          }),
        ),
      );
      assert.strictEqual(out.disposition, "held_conflict");
      assert.strictEqual(out.receiptRecord.verdict, "partial_coverage");
      assert.strictEqual(out.receiptRecord.sourceReportHash, staged.claimed);
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("retro scope is authenticated before any artifact read or receipt", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const staged = stage(h, reportFor("mission", seeded));
      const store = yield* ReportStore.MissionRetroReportStore;
      const res = yield* store
        .receive(
          cmdFor("mission", seeded.checkpointId, staged, "receive-scope", 2, { retroEpoch: 99 }),
        )
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(res));
      assert.strictEqual(h.calls.read, 0);
      assert.strictEqual(h.calls.prepare, 0);
      assert.strictEqual(receiptsOf(yield* current()).length, 0);
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("missing analysis and failed-terminal analyses cannot advance a report", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* Effect.gen(function* () {
      const checkpointId = yield* seedCaptureOnly("plain");
      const store = yield* ReportStore.MissionRetroReportStore;
      const res = yield* store.receive({
        commandId: CommandId.make("receive-none"),
        missionId: "plain",
        checkpointId,
        expectedRevision: 1,
        retroEpoch: 4,
        originalArtifactRef: "retro-original:missing",
        originalArtifactSha: "a".repeat(64),
        claimedSourceReportHash: "a".repeat(64),
      });
      assert.strictEqual(errCode(res), "analysis_missing");
      assert.strictEqual(h.calls.read, 0);
      const seeded = yield* seedClaim("term");
      h.terminal.status = "failed";
      ok(yield* settle("term", seeded, "settle-term", 2));
      const staged = stage(h, reportFor("term", seeded));
      const out = yield* store.receive(cmdFor("term", seeded.checkpointId, staged, "receive-term", 3));
      assert.strictEqual(errCode(out), "terminal_denied");
      assert.strictEqual(receiptsOf(yield* current("term")).length, 0);
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("forged artifact, normalized integrity and malformed reports are durably denied", () =>
  Effect.gen(function* () {
    const h = harness({ tamperNormalizedSha: true });
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const staged = stage(h, reportFor("mission", seeded));
      const store = yield* ReportStore.MissionRetroReportStore;
      const forged = yield* store.receive(
        cmdFor("mission", seeded.checkpointId, staged, "receive-f1", 2, {
          originalArtifactSha: "0".repeat(64),
        }),
      );
      assert.strictEqual(errCode(forged), "artifact_mismatch");
      const normalized = yield* store.receive(
        cmdFor("mission", seeded.checkpointId, staged, "receive-f2", 2),
      );
      assert.strictEqual(errCode(normalized), "artifact_mismatch");
      assert.strictEqual(receiptsOf(yield* current()).length, 0);
      // Exact replay of a durable denial returns the same denial, no port read.
      const reads = h.calls.read;
      const replay = yield* store.receive(
        cmdFor("mission", seeded.checkpointId, staged, "receive-f1", 2, {
          originalArtifactSha: "0".repeat(64),
        }),
      );
      assert.strictEqual(errCode(replay), "artifact_mismatch");
      assert.strictEqual(h.calls.read, reads);
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("normalized bytes that differ from the server report are denied", () =>
  Effect.gen(function* () {
    const h = harness({
      normalizedOverride: (report) => ({ ...report, summary: "tampered" }),
    });
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const staged = stage(h, reportFor("mission", seeded));
      const store = yield* ReportStore.MissionRetroReportStore;
      const out = yield* store.receive(cmdFor("mission", seeded.checkpointId, staged));
      assert.strictEqual(errCode(out), "artifact_mismatch");
      assert.strictEqual(receiptsOf(yield* current()).length, 0);
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("canonical fence and token drift during port work fails closed", () =>
  Effect.gen(function* () {
    const gate = Deferred.makeUnsafe<void>();
    const entered = Deferred.makeUnsafe<void>();
    const h = harness({ gate, entered });
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const staged = stage(h, reportFor("mission", seeded));
      const store = yield* ReportStore.MissionRetroReportStore;
      const fiber = yield* Effect.forkChild(store.receive(cmdFor("mission", seeded.checkpointId, staged)));
      yield* Deferred.await(entered);
      const sql = yield* SqlClient.SqlClient;
      const mission = yield* current();
      const analyses = (mission.execution?.retroAnalyses ?? []).map((record) =>
        record.checkpointId === seeded.checkpointId && record.lease !== null
          ? {
              ...record,
              fence: record.fence + 1,
              lease: { ...record.lease, assignmentToken: "f".repeat(64) },
            }
          : record,
      );
      const mutated: MissionValue = {
        ...mission,
        revision: mission.revision + 1,
        execution: { ...(mission.execution ?? { admissions: [], writerClaims: [], consumedExceptionIds: [] }), retroAnalyses: analyses },
      };
      const json = yield* encodeSnapshot(mutated);
      yield* sql`UPDATE projection_missions SET revision = ${mutated.revision}, snapshot_json = ${json} WHERE mission_id = ${"mission"}`;
      yield* Deferred.succeed(gate, undefined);
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(exit._tag === "Failure");
      assert.strictEqual((yield* reportEvents()).length, 0);
      assert.strictEqual(receiptsOf(yield* current()).length, 0);
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("stale expected revision and receipt faults leave no trace", () =>
  Effect.gen(function* () {
    const h = harness({ failReceipts: true });
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const staged = stage(h, reportFor("mission", seeded));
      const store = yield* ReportStore.MissionRetroReportStore;
      const stale = yield* store
        .receive(cmdFor("mission", seeded.checkpointId, staged, "receive-stale", 999))
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(stale));
      const fault = yield* store.receive(cmdFor("mission", seeded.checkpointId, staged)).pipe(Effect.result);
      assert.isTrue(Result.isFailure(fault));
      assert.strictEqual(receiptsOf(yield* current()).length, 0);
      assert.strictEqual((yield* reportEvents()).length, 0);
      assert.strictEqual((yield* current()).revision, 2);
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("an enclosing transaction is denied before any port work", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const staged = stage(h, reportFor("mission", seeded));
      const store = yield* ReportStore.MissionRetroReportStore;
      const sql = yield* SqlClient.SqlClient;
      const res = yield* sql
        .withTransaction(store.receive(cmdFor("mission", seeded.checkpointId, staged)))
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(res));
      assert.strictEqual(h.calls.read, 0);
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("generic create cannot forge receipts and generic replace preserves them", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* Effect.gen(function* () {
      const svc = yield* MissionService.MissionService;
      const forgedMission: MissionValue = {
        ...fixture("forged"),
        execution: {
          admissions: [],
          writerClaims: [],
          consumedExceptionIds: [],
          results: [],
          retroCheckpoints: [],
          retroAnalyses: [],
          retroReportReceipts: [
            {
              checkpointId: "retro-one",
              teamId: "team",
              environmentId: "env",
              missionId: "forged",
              sourceThreadId: "origin",
              sourceRoot: "thread://origin",
              snapshotFingerprint: FINGERPRINT,
              coveredFromInclusive: 1,
              coveredToExclusive: 2,
              reporterChildThreadId: "child-1",
              reporterRunId: "run-1",
              assignmentToken: "b".repeat(64),
              fence: 1,
              attemptNumber: 1,
              reportRevision: 1,
              accountId: "account",
              providerInstanceId: "muse-personal",
              modelId: "muse-spark-1.3-contributor",
              profile: "muse-review",
              company: "No Fun",
              originalArtifactRef: "retro-original:x",
              originalArtifactSha: "c".repeat(64),
              claimedSourceReportHash: "d".repeat(64),
              sourceReportHash: "d".repeat(64),
              normalizedArtifactRef: `retro-normalized:${"e".repeat(64)}`,
              normalizedArtifactSha: "f".repeat(64),
              coverageEvidenceRef: "retro-coverage:fixture",
              coverageEvidenceSha: "a".repeat(64),
              normalizedReportHash: "e".repeat(64),
              verdict: "no_change",
              disposition: "queued_for_triage",
              coverageFull: true,
              coverageReasonRefs: [],
              incidentCount: 0,
              shortlistCount: 0,
              incidentArtifactRef: `retro-normalized:${"e".repeat(64)}`,
              receivedAt: "2026-10-14T00:00:00.000Z",
              quarantine: [],
            },
          ],
        },
      };
      const createRes = yield* svc
        .execute({ type: "mission.create", commandId: CommandId.make("create-forged"), mission: forgedMission })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(createRes));
      const seeded = yield* seedClaim();
      const staged = stage(h, reportFor("mission", seeded));
      const store = yield* ReportStore.MissionRetroReportStore;
      ok(yield* store.receive(cmdFor("mission", seeded.checkpointId, staged)));
      const before = yield* current();
      yield* svc.execute({
        type: "mission.replace",
        commandId: CommandId.make("replace-1"),
        expectedRevision: before.revision,
        epoch: 3,
        authority: AUTHORITY,
        mission: { ...before, revision: before.revision + 1, updatedAt: "2026-10-14T01:00:00.000Z" },
      });
      assert.strictEqual(receiptsOf(yield* current()).length, 1);
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("file database close and reopen replays the saved outcome without the port", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "p2-report-" });
      const h = harness();
      const db = () => h.base.pipe(Layer.provideMerge(Sqlite.layerFromPath(`${dir}/state.sqlite`)));
      const first = yield* Effect.gen(function* () {
        const seeded = yield* seedClaim();
        const staged = stage(h, reportFor("mission", seeded));
        const store = yield* ReportStore.MissionRetroReportStore;
        const out = ok(yield* store.receive(cmdFor("mission", seeded.checkpointId, staged)));
        return { out, seeded, staged };
      }).pipe(Effect.provide(db()));
      const reads = h.calls.read;
      yield* Effect.gen(function* () {
        const store = yield* ReportStore.MissionRetroReportStore;
        const replay = ok(
          yield* store.receive(cmdFor("mission", first.seeded.checkpointId, first.staged)),
        );
        assert.isFalse(replay.committed);
        assert.deepStrictEqual(replay.receiptRecord, first.out.receiptRecord);
        assert.strictEqual(replay.eventSequence, first.out.eventSequence);
        assert.strictEqual((yield* reportEvents()).length, 1);
      }).pipe(Effect.provide(db()));
      assert.strictEqual(h.calls.read, reads);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);




it.effect("an alias of a normalized report does not prepare a second artifact", () =>
  Effect.gen(function* () {
    const h = harness();
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const incident: IncidentValue = { incidentId: "one", concernId: "concern",
        sourceEventRef: "event", summary: "s", destinationOwner: "runtime_tool" };
      const staged = stage(h, reportFor("mission", seeded, 1, 2, {
        incidents: [incident, { ...incident, incidentId: "alias" }],
      }));
      const store = yield* ReportStore.MissionRetroReportStore;
      const first = ok(yield* store.receive(cmdFor("mission", seeded.checkpointId, staged)));
      const count = h.calls.prepare;
      const alias = ok(yield* store.receive(cmdFor("mission", seeded.checkpointId, staged, "new-alias", 999)));
      assert.strictEqual(alias.normalizedArtifactRef, first.normalizedArtifactRef);
      assert.strictEqual(h.calls.prepare, count);
      assert.strictEqual(h.normalized.size, 1);
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("authority is rechecked before recording an artifact rejection after I/O", () =>
  Effect.gen(function* () {
    const gate = Deferred.makeUnsafe<void>();
    const entered = Deferred.makeUnsafe<void>();
    const h = harness({ gate, entered, tamperNormalizedSha: true });
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const staged = stage(h, reportFor("mission", seeded));
      const command = cmdFor("mission", seeded.checkpointId, staged);
      const store = yield* ReportStore.MissionRetroReportStore;
      const fiber = yield* Effect.forkChild(store.receive(command).pipe(Effect.result));
      yield* Deferred.await(entered);
      const sql = yield* SqlClient.SqlClient;
      const before = yield* current();
      const changed: MissionValue = { ...before, revision: before.revision + 1,
        managers: { ...before.managers, retro: { threadId: ThreadId.make("new-retro"), epoch: 5 } } };
      const snapshot = yield* encodeSnapshot(changed);
      yield* sql.unsafe("UPDATE projection_missions SET revision = ?, snapshot_json = ? WHERE mission_id = 'mission'", [changed.revision, snapshot]);
      yield* Deferred.succeed(gate, undefined);
      const result = yield* Fiber.join(fiber);
      assert.isTrue(Result.isFailure(result));
      const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId({ commandId: command.commandId })));
    }).pipe(Effect.provide(memory(h)));
  }),
);

it.effect("coverage reasons beyond the bounded snapshot stay linked in immutable evidence", () =>
  Effect.gen(function* () {
    const required = Array.from({ length: 18 }, (_, index) => ({ ...chunkFor(1, 2), chunkRef: index === 0 ? "chunk-1-2" : "extra-" + index }));
    const h = harness({ coverage: { manifestSourceRefs: required, readReceipts: [required[0]!],
      apiCoverage: "partial", childLogCoverage: "unknown", rawStdoutCoverage: "unknown" } });
    return yield* Effect.gen(function* () {
      const seeded = yield* seedClaim();
      const staged = stage(h, reportFor("mission", seeded));
      const out = ok(yield* (yield* ReportStore.MissionRetroReportStore).receive(cmdFor("mission", seeded.checkpointId, staged)));
      const ref: unknown = Reflect.get(out.receiptRecord, "coverageEvidenceRef");
      if (typeof ref !== "string") assert.fail("Coverage evidence pointer is missing.");
      const bytes = h.coverageEvidence.get(ref);
      assert.isString(bytes);
      assert.include(bytes!, "extra-17");
      assert.include(bytes!, "raw stdout coverage is unknown");
      assert.strictEqual(out.disposition, "held_partial");
    }).pipe(Effect.provide(memory(h)));
  }),
);
