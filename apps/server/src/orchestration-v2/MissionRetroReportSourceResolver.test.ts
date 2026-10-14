// @effect-diagnostics nodeBuiltinImport:off -- native offline source-resolver integration tests.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  Mission,
  MissionId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TeamId,
  TurnItemId,
  MessageId,
  RunId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import type { Mission as MissionValue } from "../../../../packages/contracts/src/mission.ts";
import type { MissionRetroReport as ReportValue } from "../../../../packages/contracts/src/missionRetroReport.ts";
import type { MissionRetroSourceRef as SourceRefValue } from "../../../../packages/contracts/src/missionRetro.ts";
import { computeRetroReportHash, withActualReportHash } from "./MissionRetroReportReconciliation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Registry from "../mcp/McpSessionRegistry.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Authority from "../mcp/MissionMcpAuthority.ts";
import * as Policy from "../mcp/MissionMcpPolicy.ts";
import * as MissionMcp from "../mcp/MissionMcpService.ts";
import * as OrchestratorMcp from "../mcp/OrchestratorMcpService.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Projects from "./ProjectStore.ts";
import * as MissionService from "./MissionService.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Checkpoints from "./MissionRetroCheckpointStore.ts";
import * as Analysis from "./MissionRetroAnalysisStore.ts";
import * as Artifacts from "./MissionRetroReportArtifacts.ts";
import * as ReportStore from "./MissionRetroReportStore.ts";
import * as Capture from "./MissionRetroSourceCapture.ts";
import * as Resolver from "./MissionRetroReportSourceResolver.ts";
import type * as Manifest from "./MissionRetroSourceManifest.ts";
import type { OrchestratorMcpThreadReadResult } from "../../../../packages/contracts/src/orchestratorMcp.ts";

// Controlled FS passthrough; one test briefly gates native reads without touching bytes.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, link: vi.fn(actual.link), readFile: vi.fn(actual.readFile) };
});

const env = EnvironmentId.make("resolver-env");
const root = ThreadId.make("resolver-root");
const retro = ThreadId.make("resolver-retro");
const project = ProjectId.make("resolver-project");
const instance = ProviderInstanceId.make("resolver-account");
const team = TeamId.make("resolver-team");
const mid = MissionId.make("resolver-mission");
const now = "2026-10-14T00:00:00.000Z";
const sha = (text: string) => NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
const decodeMission = Schema.decodeSync(Mission);
const decodeJsonUnknown = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const deliveryAuthority = { teamId: team, environmentId: env, controllerThreadId: root };
const retroAuthority = { teamId: team, environmentId: env, controllerThreadId: retro };
const sourceRoot = `thread://${root}`;

const fixture = (): MissionValue =>
  decodeMission({
    schemaVersion: 1,
    id: mid,
    revision: 0,
    teamId: team,
    authorityEnvironmentId: env,
    bindings: [
      {
        projectId: project,
        workspaceRoot: "/tmp/resolver-project",
        baseCommit: "base",
        ancestry: ["base"],
      },
    ],
    intent: {
      outcome: "Resolve",
      scope: ["resolve"],
      exclusions: [],
      authorityRefs: [{ source: "user", ref: "test" }],
      acceptanceCriteria: [{ id: "ac", text: "resolve" }],
      decisions: [],
    },
    integrationTarget: { summary: "Candidate" },
    managers: {
      delivery: { threadId: root, epoch: 3 },
      retro: { threadId: retro, epoch: 4 },
    },
    status: "active",
    tasks: [],
    updatedAt: now,
  });

const captureCommand = (
  over: Partial<Checkpoints.MissionRetroCaptureCommand> = {},
): Checkpoints.MissionRetroCaptureCommand => ({
  commandId: CommandId.make("resolver-capture-1"),
  missionId: mid,
  expectedRevision: 0,
  deliveryEpoch: 3,
  sourceThreadId: root,
  fromInclusive: 0,
  toExclusive: 1,
  trigger: "milestone",
  ...over,
});

const page = (): OrchestratorMcpThreadReadResult => ({
  thread: {
    threadId: root,
    projectId: project,
    title: "Private project",
    createdBy: "user",
    creationSource: "web",
    status: "running",
    latestRunId: null,
    activeRunId: null,
    providerInstanceId: instance,
    model: "configured-model",
    runtimeMode: "full-access",
    interactionMode: "default",
    linkedPullRequest: null,
    titleRegeneration: null,
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    relationshipToParent: null,
    runCount: 0,
    itemCount: 1,
    pendingRequestCount: 0,
    archived: false,
    settled: false,
    settledAt: null,
    createdAt: now,
    updatedAt: now,
  },
  items: [
    {
      position: 0,
      visibility: "local",
      sourceThreadId: root,
      itemId: TurnItemId.make("resolver-item-1"),
      runId: RunId.make("resolver-run-1"),
      messageId: MessageId.make("resolver-message-1"),
      createdBy: "agent",
      creationSource: "mcp",
      type: "assistant_message",
      status: "completed",
      title: null,
      text: "genuine source text",
      textTruncated: false,
      nextTextOffset: null,
      updatedAt: now,
    },
  ],
  recentRuns: [],
  nextPosition: 0,
  hasMore: false,
});

const keep: Manifest.MissionRetroSourceSanitizer = ({ value }) =>
  Effect.succeed({ kind: "kept", value });

const base = Layer.mergeAll(Projections.layer, Projects.layer, Events.layer, Receipts.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const scoped = <A, E, R>(task: Effect.Effect<A, E, R>) =>
  task.pipe(Effect.provide(base), Effect.scoped, Effect.provide(NodeServices.layer));

const omitAll: Manifest.MissionRetroSourceSanitizer = () =>
  Effect.succeed({ kind: "omitted", cause: "test omit all" });

const makeSetup = (sanitize: Manifest.MissionRetroSourceSanitizer) =>
  Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "report-source-resolver-" });
  const projects = yield* Projects.ProjectStoreV2;
  const projections = yield* Projections.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  yield* projects.apply({
    sequence: 1,
    eventId: EventId.make("resolver-project-created"),
    aggregateKind: "project",
    aggregateId: project,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: project,
      title: "Fixture",
      workspaceRoot: "/tmp/resolver-project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  const date = DateTime.makeUnsafe(now);
  yield* projections.apply({
    id: EventId.make("resolver-thread-created"),
    type: "thread.created",
    threadId: root,
    occurredAt: date,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: root,
      projectId: project,
      title: "Root",
      providerInstanceId: instance,
      modelSelection: { instanceId: instance, model: "configured-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: root },
      forkedFrom: null,
      createdAt: date,
      updatedAt: date,
      archivedAt: null,
      settledAt: null,
      settledOverride: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  const environment = ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(env),
    getDescriptor: Effect.die("Unused"),
  });
  const registry = yield* Registry.__testing.make({ now: () => 1000, livenessWindowMs: 100 }).pipe(
    Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
    Effect.provideService(HttpServer.HttpServer, {
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43124),
      serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
    }),
  );
  const credential = yield* registry.issue({ threadId: root, providerInstanceId: instance });
  const caller = yield* registry.resolve(
    credential.config.authorizationHeader.replace(/^Bearer\s+/, ""),
  );
  if (caller === undefined) return yield* Effect.die("Missing test credential");
  const publisher = new Policy.MissionMcpPolicyPublisher();
  publisher.publish({
    company: "nofun",
    companyVerified: true,
    bindingVerified: true,
    policyRef: "server-policy:test",
    teamId: team,
    environmentId: env,
    allowedProjectIds: [project],
    bootstrapControllerThreadIds: [root],
  });
  const authority = yield* MissionMcp.MissionMcpAuthorityPort.pipe(
    Effect.provide(Authority.layer),
    Effect.provideService(Registry.McpSessionRegistry, registry),
    Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
    Effect.provideService(Authority.MissionMcpTrustedPolicy, publisher.policy),
  );
  const missions = yield* MissionMcp.MissionMcpService.pipe(
    Effect.provide(MissionMcp.layer),
    Effect.provideService(MissionMcp.MissionMcpAuthorityPort, authority),
  );
  const service = yield* MissionService.MissionService.pipe(
    Effect.provide(MissionService.layer),
    Effect.provideService(MissionService.MissionAuthority, deliveryAuthority),
  );
  yield* service.execute({
    type: "mission.create",
    commandId: CommandId.make("resolver-seed"),
    mission: fixture(),
  });
  const read = {
    current: Effect.sync(page),
  };
  const snapshotPort = yield* Checkpoints.MissionRetroSnapshotPort.pipe(
    Effect.provide(
      Capture.layerSourceCapture({
        artifactDirectory: dir,
        sanitize,
        authorizeSource: () => Effect.void,
        triggerGate: () => Effect.void,
      }),
    ),
    Effect.provideService(MissionMcp.MissionMcpService, missions),
    Effect.provideService(MissionMcp.MissionMcpAuthorityPort, authority),
    Effect.provide(
      Layer.mock(OrchestratorMcp.OrchestratorMcpService)({
        readThread: () =>
          Effect.gen(function* () {
            assert.isTrue(Option.isNone(yield* Effect.serviceOption(sql.transactionService)));
            return yield* read.current;
          }),
      }),
    ),
    Effect.provideService(Invocation.McpInvocationContext, caller),
  );
  const checkpointStore = yield* Checkpoints.MissionRetroCheckpointStore.pipe(
    Effect.provide(Checkpoints.layer),
    Effect.provideService(Checkpoints.MissionRetroSnapshotPort, snapshotPort),
    Effect.provideService(MissionService.MissionAuthority, deliveryAuthority),
  );
  const factsPort = Layer.succeed(Analysis.MissionRetroAnalysisFactsPort, {
    readClaimFacts: (
      cmd: Analysis.MissionRetroAnalysisClaimCommand,
      cp: Analysis.MissionRetroAnalysisCheckpoint,
    ) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        return {
          teamId: team,
          environmentId: env,
          missionId: cmd.missionId,
          checkpointId: cp.checkpointId,
          retroThreadId: retro,
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
            ready: true,
            exhausted: false,
            lowReserve: false,
            verified: true,
            company: "No Fun",
            accountId: "resolver-account",
            providerInstanceId: "muse-personal" as const,
            modelId: "muse-spark-1.3-contributor",
            profile: "muse-review",
            observedAtMs: nowMs,
            accountRef: "resolver-account-ref",
            providerRef: "resolver-provider-ref",
            capacityRef: "resolver-capacity-ref",
          },
          host: {
            hostId: "resolver-host",
            bootId: "resolver-boot",
            verified: true,
            interactivePressureVerified: true,
            pressureReady: true,
            buildVerified: true,
            productiveWorkPriority: true,
            observedAtMs: nowMs,
            hostRef: "resolver-host-ref",
            buildRef: "resolver-build-ref",
            priorityRef: "resolver-priority-ref",
          },
          prepared: {
            reporterChildThreadId: `child-${cmd.missionId}`,
            reporterRunId: `run-${cmd.missionId}`,
            verified: true,
            receiptRef: "resolver-prepared-ref",
          },
        };
      }),
    readTerminalFacts: () => Effect.die("Unused in resolver tests"),
  });
  const analysisStore = yield* Analysis.MissionRetroAnalysisStore.pipe(
    Effect.provide(Analysis.layer.pipe(Layer.provide(factsPort))),
    Effect.provideService(MissionService.MissionAuthority, retroAuthority),
  );
  const resolver = yield* Artifacts.MissionRetroReportTrustedResolver.pipe(
    Effect.provide(Resolver.layerMissionRetroReportSourceResolver({ artifactDirectory: dir })),
    Effect.provideService(MissionService.MissionAuthority, retroAuthority),
  );
  const artifactPort = yield* ReportStore.MissionRetroReportArtifactPort.pipe(
    Effect.provide(Artifacts.layerFilesystemReportArtifactPort(dir)),
    Effect.provideService(Artifacts.MissionRetroReportTrustedResolver, resolver),
  );
  const reportStore = yield* ReportStore.MissionRetroReportStore.pipe(
    Effect.provide(ReportStore.layer),
    Effect.provideService(ReportStore.MissionRetroReportArtifactPort, artifactPort),
    Effect.provideService(MissionService.MissionAuthority, retroAuthority),
  );
  const events = yield* Events.OrchestrationEventStore;
  const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
  return { dir, sql, service, snapshotPort, checkpointStore, analysisStore, reportStore, resolver, events, receipts, read };
  });

const setup = makeSetup(keep);
const setupOmit = makeSetup(omitAll);

type Handles = Effect.Success<typeof setup>;

interface Stack {
  readonly checkpointId: string;
  readonly fingerprint: string;
  readonly sourceRefs: ReadonlyArray<SourceRefValue>;
  readonly lease: {
    readonly reporterChildThreadId: string;
    readonly reporterRunId: string;
    readonly reportRevision: number;
    readonly assignmentToken: string;
  };
  readonly revision: number;
}

const ok = <A, E>(result: Result.Result<A, E>): A => {
  assert.isTrue(Result.isSuccess(result), "expected success result");
  if (Result.isSuccess(result)) return result.success;
  throw new Error("unreachable");
};

const currentMission = (h: Handles) =>
  Effect.gen(function* () {
    return Option.getOrThrow(yield* h.service.get(mid));
  });

const commitStack = (h: Handles, claimId = "resolver-claim-1") =>
  Effect.gen(function* () {
    const snapshot = yield* h.snapshotPort.readSnapshot(captureCommand());
    const captured = ok(yield* h.checkpointStore.capture(captureCommand()));
    const claimed = ok(
      yield* h.analysisStore.claim({
        commandId: CommandId.make(claimId),
        missionId: mid,
        checkpointId: captured.checkpoint.checkpointId,
        expectedRevision: 1,
        retroEpoch: 4,
      }),
    );
    const lease = claimed.analysis.lease;
    assert.isNotNull(lease, "claim must produce a lease");
    if (lease === null) throw new Error("unreachable");
    const mission = yield* currentMission(h);
    return {
      snapshot,
      checkpointId: captured.checkpoint.checkpointId,
      fingerprint: captured.checkpoint.snapshotFingerprint,
      sourceRefs: captured.checkpoint.sourceRefs,
      lease: {
        reporterChildThreadId: lease.reporterChildThreadId,
        reporterRunId: lease.reporterRunId,
        reportRevision: lease.reportRevision,
        assignmentToken: lease.assignmentToken,
      },
      revision: mission.revision,
    };
  });

type ReportOverrides = Partial<Omit<ReportValue, "reportHash">>;

const reportFor = (
  stack: Pick<Stack, "checkpointId" | "fingerprint" | "sourceRefs" | "lease">,
  over: ReportOverrides = {},
): ReportValue =>
  withActualReportHash({
    checkpointId: stack.checkpointId,
    teamId: team,
    environmentId: env,
    missionId: mid,
    sourceThreadId: root,
    sourceRoot,
    snapshotFingerprint: stack.fingerprint,
    coveredFromInclusive: 0,
    coveredToExclusive: 1,
    reporterChildThreadId: stack.lease.reporterChildThreadId,
    reporterRunId: stack.lease.reporterRunId,
    reportRevision: stack.lease.reportRevision,
    assignmentToken: stack.lease.assignmentToken,
    managerEpoch: 4,
    model: "muse-spark-1.3-contributor",
    profile: "muse-review",
    sourceRefs: [...stack.sourceRefs],
    // Forged prepared-read refs ride along as worker claims; the resolver
    // must never read or promote them.
    claimedReadRefs: [`retro-source-read:${"f".repeat(64)}`],
    summary: "genuine summary",
    verdict: "no_change",
    shortlist: [],
    incidents: [],
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
    omissions: [],
    ...over,
  });

const ingest = (h: Handles, report: ReportValue) =>
  Artifacts.ingestRetroReportOriginal({
    artifactDirectory: h.dir,
    descriptorBytes: stableStringify(report),
  });

const receiveCommand = (
  stack: Pick<Stack, "checkpointId" | "revision">,
  staged: { readonly originalArtifactRef: string; readonly originalArtifactSha: string },
  report: ReportValue,
  commandId: string,
  over: Partial<ReportStore.MissionRetroReportReceiveCommand> = {},
): ReportStore.MissionRetroReportReceiveCommand => ({
  commandId: CommandId.make(commandId),
  missionId: mid,
  checkpointId: stack.checkpointId,
  expectedRevision: stack.revision,
  retroEpoch: 4,
  originalArtifactRef: staged.originalArtifactRef,
  originalArtifactSha: staged.originalArtifactSha,
  claimedSourceReportHash: computeRetroReportHash(report),
  ...over,
});

const denied = (h: Handles, command: ReportStore.MissionRetroReportReceiveCommand) =>
  Effect.gen(function* () {
    const failure = yield* h.reportStore.receive(command).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "MissionRetroReportStoreError");
    assert.strictEqual(failure.category, "scope_denied");
    // Fixed bounded error: no raw cause, SQL, path, or body leaks out.
    assert.isUndefined(failure.cause);
    assert.notInclude(stableStringify(failure), "genuine source text");
    return failure;
  });

const noteRef = (h: Handles, prefix: string) =>
  Effect.gen(function* () {
    const mission = yield* currentMission(h);
    const checkpoint = (mission.execution?.retroCheckpoints ?? []).find(
      (entry) => entry.checkpointId === mission.execution?.retroAnalyses?.[0]?.checkpointId,
    );
    assert.isDefined(checkpoint, "canonical checkpoint must exist");
    const notes = (checkpoint?.omissions ?? []).filter((note) => note.startsWith(prefix));
    return { checkpoint, notes };
  });

const readNoteBytes = (h: Handles, ref: string) =>
  Artifacts.readArtifactBytes({
    artifactDirectory: h.dir,
    namespace: "retro-source",
    ref,
    maxBytes: 2097152,
  });

/** Rewrite the canonical snapshot JSON in place (test fixture surgery only). */
const patchSnapshot = (
  h: Handles,
  mutate: (raw: Record<string, unknown>) => void,
) =>
  Effect.gen(function* () {
    const rows = yield* h.sql<{
      snapshot_json: string;
    }>`SELECT snapshot_json FROM projection_missions WHERE mission_id = ${mid}`;
    assert.isDefined(rows[0], "mission row must exist");
    const raw = decodeJsonUnknown(rows[0].snapshot_json) as Record<string, unknown>;
    mutate(raw);
    yield* h.sql`UPDATE projection_missions SET snapshot_json = ${stableStringify(raw)} WHERE mission_id = ${mid}`;
  });

const setCheckpointOmissions = (h: Handles, omissions: ReadonlyArray<string>) =>
  patchSnapshot(h, (raw) => {
    const execution = raw["execution"] as Record<string, unknown>;
    const checkpoints = execution["retroCheckpoints"] as Array<Record<string, unknown>>;
    checkpoints[0]!["omissions"] = [...omissions];
  });

const setFingerprint = (h: Handles, fingerprint: string) =>
  patchSnapshot(h, (raw) => {
    const execution = raw["execution"] as Record<string, unknown>;
    const checkpoints = execution["retroCheckpoints"] as Array<Record<string, unknown>>;
    checkpoints[0]!["snapshotFingerprint"] = fingerprint;
    const analyses = execution["retroAnalyses"] as Array<Record<string, unknown>>;
    if (analyses[0] !== undefined) analyses[0]["snapshotFingerprint"] = fingerprint;
  });

const setDelivery = (h: Handles, threadId: string, epoch: number) =>
  patchSnapshot(h, (raw) => {
    const managers = raw["managers"] as Record<string, unknown>;
    managers["delivery"] = { threadId, epoch };
  });

const setRetroEpoch = (h: Handles, epoch: number) =>
  patchSnapshot(h, (raw) => {
    const managers = raw["managers"] as Record<string, unknown>;
    const retroManagers = managers["retro"] as Record<string, unknown>;
    managers["retro"] = { ...retroManagers, epoch };
  });

const commitSourceBytes = (h: Handles, text: string) =>
  Effect.gen(function* () {
    const hash = sha(text);
    yield* Artifacts.commitArtifactBytes({
      artifactDirectory: h.dir,
      namespace: "retro-source",
      sha: hash,
      bytes: Buffer.from(text, "utf8"),
    });
    return `retro-source:${hash}`;
  });

const replaceNote = (h: Handles, prefix: string, ref: string) =>
  Effect.gen(function* () {
    const mission = yield* currentMission(h);
    const omissions = mission.execution?.retroCheckpoints?.[0]?.omissions ?? [];
    yield* setCheckpointOmissions(
      h,
      omissions.map((note) => (note.startsWith(prefix) ? `${prefix}${ref}` : note)),
    );
  });

const manifestText = (h: Handles) =>
  Effect.gen(function* () {
    const { notes } = yield* noteRef(h, "source-manifest:");
    assert.strictEqual(notes.length, 1);
    return (yield* readNoteBytes(h, notes[0]!.slice("source-manifest:".length))).text;
  });

const bindingRecord = (h: Handles) =>
  Effect.gen(function* () {
    const { notes } = yield* noteRef(h, "source-binding:");
    assert.strictEqual(notes.length, 1);
    return {
      ref: notes[0]!.slice("source-binding:".length),
      record: (yield* readNoteBytes(h, notes[0]!.slice("source-binding:".length))).text,
    };
  });

it.effect(
  "genuine manifest provenance downgrades valid no_change to held_partial with no receipts",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const stack = yield* commitStack(h);
        const report = reportFor(stack);
        const staged = yield* ingest(h, report);
        assert.strictEqual(staged.originalArtifactSha, sha(stableStringify(report)));
        const out = ok(
          yield* h.reportStore.receive(receiveCommand(stack, staged, report, "resolver-receive-1")),
        );
        assert.isTrue(out.committed);
        assert.strictEqual(out.disposition, "held_partial");
        assert.strictEqual(out.receiptRecord.verdict, "partial_coverage");
        assert.isFalse(out.receiptRecord.coverageFull);
        assert.strictEqual(out.sourceReportHash, computeRetroReportHash(report));
        // No trusted read receipts: coverage reasons must cite the receipt gap.
        assert.include(
          out.receiptRecord.coverageReasonRefs.join(" "),
          "retro-reason:",
        );
        // Forged native skill invocation never survives normalization.
        const normalized = yield* Artifacts.readArtifactBytes({
          artifactDirectory: h.dir,
          namespace: "retro-normalized",
          ref: out.normalizedArtifactRef,
          maxBytes: 524288,
        });
        assert.notInclude(normalized.text, "native_invoked");
        assert.notInclude(stableStringify(out), "genuine source text");
      }),
    ),
);

it.effect("legacy version1 binding without origin proof is denied, never upgraded", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const stack = yield* commitStack(h);
      const manifest = decodeJsonUnknown(yield* manifestText(h)) as Record<string, unknown>;
      const scope = manifest["scope"] as Record<string, unknown>;
      const { notes } = yield* noteRef(h, "source-manifest:");
      const legacy = stableStringify({
        version: 1,
        captureBoundaryId: scope["captureBoundaryId"],
        checkpointId: stack.checkpointId,
        snapshotFingerprint: stack.fingerprint,
        manifestRef: notes[0]!.slice("source-manifest:".length),
      });
      yield* replaceNote(h, "source-binding:", yield* commitSourceBytes(h, legacy));
      const report = reportFor(stack);
      const staged = yield* ingest(h, report);
      const revision = (yield* currentMission(h)).revision;
      yield* denied(
        h,
        receiveCommand({ ...stack, revision }, staged, report, "resolver-receive-legacy"),
      );
      assert.strictEqual((yield* currentMission(h)).revision, revision);
      assert.deepStrictEqual((yield* currentMission(h)).execution?.retroReportReceipts ?? [], []);
    }),
  ),
);

it.effect("missing source-manifest note is denied before filesystem reads", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const stack = yield* commitStack(h);
      const mission = yield* currentMission(h);
      const omissions = (mission.execution?.retroCheckpoints?.[0]?.omissions ?? []).filter(
        (note) => !note.startsWith("source-manifest:"),
      );
      yield* setCheckpointOmissions(h, omissions);
      const report = reportFor(stack);
      const staged = yield* ingest(h, report);
      yield* denied(h, receiveCommand(stack, staged, report, "resolver-receive-missing"));
    }),
  ),
);

it.effect("duplicated source-manifest notes are denied", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const stack = yield* commitStack(h);
      const mission = yield* currentMission(h);
      const omissions = mission.execution?.retroCheckpoints?.[0]?.omissions ?? [];
      const manifest = omissions.find((note) => note.startsWith("source-manifest:"))!;
      yield* setCheckpointOmissions(h, [...omissions, manifest]);
      const report = reportFor(stack);
      const staged = yield* ingest(h, report);
      yield* denied(h, receiveCommand(stack, staged, report, "resolver-receive-duplicate"));
    }),
  ),
);

it.effect("wrong-namespace manifest note is denied", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const stack = yield* commitStack(h);
      const report = reportFor(stack);
      const staged = yield* ingest(h, report);
      yield* replaceNote(h, "source-manifest:", staged.originalArtifactRef);
      yield* denied(h, receiveCommand(stack, staged, report, "resolver-receive-namespace"));
    }),
  ),
);

it.effect("corrupted private manifest bytes are denied", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const stack = yield* commitStack(h);
      const { notes } = yield* noteRef(h, "source-manifest:");
      const path = Artifacts.artifactPathForRef(
        h.dir,
        notes[0]!.slice("source-manifest:".length),
        "retro-source",
      );
      assert.isNotNull(path);
      yield* Effect.promise(() => NodeFSP.writeFile(path!, "corrupted bytes"));
      const report = reportFor(stack);
      const staged = yield* ingest(h, report);
      yield* denied(h, receiveCommand(stack, staged, report, "resolver-receive-corrupt"));
    }),
  ),
);

it.effect("duplicated manifest chunk entry is denied", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const stack = yield* commitStack(h);
      const parsed = decodeJsonUnknown(yield* manifestText(h)) as Record<string, unknown>;
      const chunks = parsed["chunks"] as Array<Record<string, unknown>>;
      const doubled = stableStringify({ ...parsed, chunks: [...chunks, chunks[0]] });
      const binding = decodeJsonUnknown((yield* bindingRecord(h)).record) as Record<
        string,
        unknown
      >;
      const manifestRef = yield* commitSourceBytes(h, doubled);
      // Rebind canonical fingerprint to the doubled manifest so the denial
      // isolates the duplicate-chunk shape check, not the hash check.
      const parsedScope = parsed["scope"] as Record<string, unknown>;
      const doubledChunks = (parsed["chunks"] as Array<Record<string, unknown>>).concat(chunks[0]!);
      const fingerprint = sha(
        stableStringify({
          version: 1,
          coveragePolicy: "explicit-activity-window-v1",
          teamId: parsedScope["teamId"],
          environmentId: parsedScope["environmentId"],
          missionId: parsedScope["missionId"],
          captureBoundaryId: parsedScope["captureBoundaryId"],
          sourceRoot: parsedScope["sourceRoot"],
          sourceThreadId: parsedScope["sourceThreadId"],
          fromInclusive: parsedScope["fromInclusive"],
          toExclusive: parsedScope["toExclusive"],
          threadsRead: [...(parsed["threadsRead"] as Array<string>)].sort(),
          chunkHashes: doubledChunks.map((c) => c["chunkHash"]),
          artifactSha256: sha(doubled),
        }),
      );
      const rebound = stableStringify({ ...binding, manifestRef, snapshotFingerprint: fingerprint });
      const { notes } = yield* noteRef(h, "source-manifest:");
      assert.notStrictEqual(manifestRef, notes[0]!.slice("source-manifest:".length));
      yield* replaceNote(h, "source-manifest:", manifestRef);
      yield* replaceNote(h, "source-binding:", yield* commitSourceBytes(h, rebound));
      yield* setFingerprint(h, fingerprint);
      const stack2 = { ...stack, fingerprint };
      const report = reportFor(stack2);
      const staged = yield* ingest(h, report);
      yield* denied(h, receiveCommand(stack2, staged, report, "resolver-receive-dup-chunk"));
    }),
  ),
);

it.effect("repointed binding with mismatched scope or origin is denied", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const stack = yield* commitStack(h);
      const binding = decodeJsonUnknown((yield* bindingRecord(h)).record) as Record<
        string,
        unknown
      >;
      const foreignRoot = stableStringify({ ...binding, sourceRoot: "thread://foreign" });
      yield* replaceNote(h, "source-binding:", yield* commitSourceBytes(h, foreignRoot));
      const report = reportFor(stack);
      const staged = yield* ingest(h, report);
      yield* denied(h, receiveCommand(stack, staged, report, "resolver-receive-scope"));
      const forgedOrigin = stableStringify({ ...binding, actualOrigin: "reporter" });
      yield* replaceNote(h, "source-binding:", yield* commitSourceBytes(h, forgedOrigin));
      yield* denied(h, receiveCommand(stack, staged, report, "resolver-receive-origin"));
      assert.deepStrictEqual((yield* currentMission(h)).execution?.retroReportReceipts ?? [], []);
    }),
  ),
);

it.effect("foreign original hash never reaches the resolver", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const stack = yield* commitStack(h);
      const report = reportFor(stack);
      const staged = yield* ingest(h, report);
      const failure = yield* h.reportStore
        .receive(
          receiveCommand(stack, staged, report, "resolver-receive-foreign", {
            originalArtifactSha: "f".repeat(64),
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MissionRetroReportStoreError");
      assert.strictEqual(failure.category, "persistence");
    }),
  ),
);

it.effect("staged blobs without a committed checkpoint stay denied", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      // Preparation stages immutable files but commits no checkpoint.
      const snapshot = yield* h.snapshotPort.readSnapshot(captureCommand());
      assert.strictEqual((yield* currentMission(h)).revision, 0);
      const checkpointId = Checkpoints.checkpointIdFor({
        teamId: team,
        environmentId: env,
        missionId: mid,
        sourceThreadId: root,
        fromInclusive: 0,
        toExclusive: 1,
        snapshotFingerprint: snapshot.snapshotFingerprint,
      });
      const report = reportFor(
        {
          checkpointId,
          fingerprint: snapshot.snapshotFingerprint,
          sourceRefs: snapshot.sourceRefs,
          lease: {
            reporterChildThreadId: "child-staged",
            reporterRunId: "run-staged",
            reportRevision: 1,
            assignmentToken: "a".repeat(64),
          },
        },
        { reporterChildThreadId: "child-staged", reporterRunId: "run-staged" },
      );
      const staged = yield* ingest(h, report);
      // ReportStore returns Effect<Result<_, Rejection>>: a documented
      // denial is a Success carrying Result.failure, not an Effect failure.
      const result = yield* h.reportStore.receive({
        commandId: CommandId.make("resolver-receive-staged"),
        missionId: mid,
        checkpointId,
        expectedRevision: 0,
        retroEpoch: 4,
        originalArtifactRef: staged.originalArtifactRef,
        originalArtifactSha: staged.originalArtifactSha,
        claimedSourceReportHash: computeRetroReportHash(report),
      });
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "MissionRetroReportRejection");
        if (result.failure._tag === "MissionRetroReportRejection")
          assert.strictEqual(result.failure.code, "checkpoint_missing");
      }
      assert.strictEqual((yield* currentMission(h)).revision, 0);
    }),
  ),
);

it.effect("retro role change during suspended producer I/O denies without receipt", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const stack = yield* commitStack(h);
      const report = reportFor(stack);
      const staged = yield* ingest(h, report);
      const command = receiveCommand(stack, staged, report, "resolver-receive-role");
      const actual = yield* Effect.promise(() => vi.importActual<typeof NodeFSP>("node:fs/promises"));
      const bindingPath = Artifacts.artifactPathForRef(
        h.dir,
        (yield* bindingRecord(h)).ref,
        "retro-source",
      );
      if (bindingPath === null) return yield* Effect.die("invalid binding fixture ref");
      const realBindingPath = yield* Effect.promise(() => NodeFSP.realpath(bindingPath));
      const atBinding = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      // Gate the ACTUAL binding artifact read (Artifacts uses readFile on
      // the exact content-addressed path), never a guessed call counter.
      const gated = async (...args: Array<unknown>): Promise<unknown> => {
        if (String(args[0]) === realBindingPath) {
          atBinding.resolve();
          await release.promise;
        }
        return (actual.readFile as (...call: Array<unknown>) => Promise<unknown>)(...args);
      };
      const restore = Effect.sync(() => {
        vi.mocked(NodeFSP.readFile).mockImplementation(actual.readFile as never);
        release.resolve();
      });
      const result = yield* Effect.gen(function* () {
        vi.mocked(NodeFSP.readFile).mockImplementation(gated as never);
        const fiber = yield* Effect.forkChild(h.reportStore.receive(command).pipe(Effect.result));
        // Entered-vs-completed race: a missing hook fails deterministically
        // instead of timing out into a pass.
        const enteredFirst = yield* Effect.race(
          Effect.promise(() => atBinding.promise).pipe(Effect.as(true)),
          Fiber.await(fiber).pipe(Effect.as(false)),
        );
        assert.isTrue(enteredFirst, "exact binding read must be entered before completion");
        if (!enteredFirst) return yield* Fiber.join(fiber);
        yield* setRetroEpoch(h, 5);
        release.resolve();
        return yield* Fiber.join(fiber);
      }).pipe(Effect.ensuring(restore));
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "MissionRetroReportStoreError");
        assert.strictEqual(result.failure.category, "scope_denied");
        assert.isUndefined(result.failure.cause);
      }
      assert.strictEqual((yield* currentMission(h)).revision, stack.revision);
      assert.deepStrictEqual((yield* currentMission(h)).execution?.retroReportReceipts ?? [], []);
      assert.isTrue(
        Option.isNone(yield* h.receipts.getByCommandId({ commandId: command.commandId })),
      );
    }),
  ),
);

it.effect("denied resolver read mutates no canonical mission state", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const stack = yield* commitStack(h);
      const { notes } = yield* noteRef(h, "source-binding:");
      const bindingPath = Artifacts.artifactPathForRef(
        h.dir,
        notes[0]!.slice("source-binding:".length),
        "retro-source",
      );
      assert.isNotNull(bindingPath);
      yield* Effect.promise(() => NodeFSP.unlink(bindingPath!));
      const report = reportFor(stack);
      const staged = yield* ingest(h, report);
      const command = receiveCommand(stack, staged, report, "resolver-receive-nomutate");
      yield* denied(h, command);
      const mission = yield* currentMission(h);
      assert.strictEqual(mission.revision, stack.revision);
      assert.deepStrictEqual(mission.execution?.retroReportReceipts ?? [], []);
      assert.isTrue(Option.isNone(yield* h.receipts.getByCommandId({ commandId: command.commandId })));
      const logged = yield* h.events.readMissionEvents(mid);
      assert.isTrue(logged.every((entry) => entry.type !== "mission.retro-report-received"));
    }),
  ),
);

it.effect("same canonical bytes reuse artifacts deterministically across command ids", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const stack = yield* commitStack(h);
      const report = reportFor(stack);
      const staged = yield* ingest(h, report);
      const first = ok(
        yield* h.reportStore.receive(receiveCommand(stack, staged, report, "resolver-receive-a")),
      );
      assert.strictEqual(first.disposition, "held_partial");
      const revision = (yield* currentMission(h)).revision;
      assert.strictEqual(revision, stack.revision + 1);
      const files = yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(h.dir, "retro-source")));
      const second = ok(
        yield* h.reportStore.receive(
          receiveCommand({ ...stack, revision }, staged, report, "resolver-receive-b"),
        ),
      );
      assert.strictEqual(second.sourceReportHash, first.sourceReportHash);
      assert.isFalse(second.committed);
      assert.isTrue(second.recovered);
      assert.deepStrictEqual(
        yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(h.dir, "retro-source"))),
        files,
      );
    }),
  ),
);

it.effect("report under a different assignment is quarantined, never queued", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const stack = yield* commitStack(h);
      const report = reportFor(stack, { reporterChildThreadId: "child-impostor" });
      const staged = yield* ingest(h, report);
      const out = ok(
        yield* h.reportStore.receive(receiveCommand(stack, staged, report, "resolver-receive-quarantine")),
      );
      assert.strictEqual(out.disposition, "held_quarantined");
      assert.strictEqual(out.receiptRecord.verdict, "partial_coverage");
    }),
  ),
);

it.effect("delivery handoff retaining old checkpoint still ingests held_partial", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const stack = yield* commitStack(h);
      yield* setDelivery(h, "resolver-successor", 9);
      const report = reportFor(stack);
      const staged = yield* ingest(h, report);
      const out = ok(yield* h.reportStore.receive(receiveCommand(stack, staged, report, "resolver-receive-handoff")));
      assert.strictEqual(out.disposition, "held_partial");
      assert.isFalse(out.receiptRecord.coverageFull);
    }),
  ),
);

it.effect("all-omitted empty partial capture ingests held_partial with no trusted reads", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setupOmit;
      const stack = yield* commitStack(h);
      assert.deepStrictEqual(stack.sourceRefs, []);
      const report = reportFor(stack, { sourceRefs: [] });
      const staged = yield* ingest(h, report);
      const out = ok(yield* h.reportStore.receive(receiveCommand(stack, staged, report, "resolver-receive-empty")));
      assert.strictEqual(out.disposition, "held_partial");
      assert.isFalse(out.receiptRecord.coverageFull);
    }),
  ),
);


it.effect("unknown raw coverage does not invent pending children; canonical pending note remains conservative", () =>
  scoped(Effect.gen(function* () {
    const h = yield* setup;
    const stack = yield* commitStack(h);
    const report = reportFor(stack);
    const staged = yield* ingest(h, report);
    const command = receiveCommand(stack, staged, report, "resolver-pending-metadata");
    const checkpoint = (yield* currentMission(h)).execution?.retroCheckpoints?.[0];
    assert.strictEqual(checkpoint?.coverage, "unknown");
    const metadata = yield* h.resolver.resolve({ command, originalSha: staged.originalArtifactSha, report });
    assert.strictEqual(metadata.coverage.childLogCoverage, "unknown");
    assert.strictEqual(metadata.coverage.rawStdoutCoverage, "unknown");
    assert.isFalse(metadata.coverage.pendingChildRuns);
    yield* setCheckpointOmissions(h, [...(checkpoint?.omissions ?? []), "pending-child-runs"]);
    const pending = yield* h.resolver.resolve({ command, originalSha: staged.originalArtifactSha, report });
    assert.isTrue(pending.coverage.pendingChildRuns);
    assert.deepStrictEqual(pending.coverage.readReceipts, []);
  })),
);
