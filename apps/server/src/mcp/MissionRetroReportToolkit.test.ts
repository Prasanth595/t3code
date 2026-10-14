// @effect-diagnostics nodeBuiltinImport:off -- native offline report-toolkit dispatcher integration tests.
import * as NodeFSP from "node:fs/promises";
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { McpSchema, McpServer } from "effect/ai";
import type { Mission as MissionValue } from "../../../../packages/contracts/src/mission.ts";
import type { MissionRetroReport as ReportValue } from "../../../../packages/contracts/src/missionRetroReport.ts";
import type { MissionRetroSourceRef as SourceRefValue } from "../../../../packages/contracts/src/missionRetro.ts";
import type { OrchestratorMcpThreadReadResult } from "../../../../packages/contracts/src/orchestratorMcp.ts";
import {
  computeRetroReportHash,
  withActualReportHash,
} from "../orchestration-v2/MissionRetroReportReconciliation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Registry from "./McpSessionRegistry.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as Authority from "./MissionMcpAuthority.ts";
import * as Policy from "./MissionMcpPolicy.ts";
import * as MissionMcp from "./MissionMcpService.ts";
import * as OrchestratorMcp from "./OrchestratorMcpService.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as MissionService from "../orchestration-v2/MissionService.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Checkpoints from "../orchestration-v2/MissionRetroCheckpointStore.ts";
import * as Analysis from "../orchestration-v2/MissionRetroAnalysisStore.ts";
import * as Artifacts from "../orchestration-v2/MissionRetroReportArtifacts.ts";
import * as ReportStore from "../orchestration-v2/MissionRetroReportStore.ts";
import * as Capture from "../orchestration-v2/MissionRetroSourceCapture.ts";
import * as Resolver from "../orchestration-v2/MissionRetroReportSourceResolver.ts";
import type * as Manifest from "../orchestration-v2/MissionRetroSourceManifest.ts";
import * as ReportMcp from "./MissionRetroReportMcpService.ts";
import * as ReportToolkit from "./MissionRetroReportToolkit.ts";

/**
 * Native offline coverage for the optional retro report toolkit seam. Every
 * call goes through the real in-memory Effect MCP dispatcher with its SDK
 * client service and a fresh registry-resolved per-request scope, into the
 * real handler and the actual accepted ReportMcpService over real memory
 * SQL/projections, the actual session registry and policy publisher, and the
 * private Capture -> Checkpoint -> Analysis -> SourceResolver -> Artifact ->
 * ReportStore stack. The sole doubles are the thread-read page and the
 * facts-port capacity/host ports the accepted service fixture already
 * isolates; no mocked auth or service anywhere.
 *
 * These are dispatcher integration tests on the local in-memory Effect
 * dispatcher path only: no HTTP, no transport delivery verification.
 */

// Controlled FS passthrough; strict-input tests assert no private reads/links.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, link: vi.fn(actual.link), readFile: vi.fn(actual.readFile) };
});

const TOOL = "mission_retro_report_receive";
const env = EnvironmentId.make("resolver-env");
const root = ThreadId.make("resolver-root");
const retro = ThreadId.make("resolver-retro");
const project = ProjectId.make("resolver-project");
const instance = ProviderInstanceId.make("resolver-account");
const team = TeamId.make("resolver-team");
const mid = MissionId.make("resolver-mission");
const now = "2026-10-14T00:00:00.000Z";
const decodeMission = Schema.decodeSync(Mission);
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

const policyConfig = () => ({
  company: "nofun",
  companyVerified: true,
  bindingVerified: true,
  policyRef: "server-policy:test",
  teamId: team,
  environmentId: env,
  allowedProjectIds: [project],
  bootstrapControllerThreadIds: [root],
});

const makeSetup = (sanitize: Manifest.MissionRetroSourceSanitizer) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "report-toolkit-" });
    const dir = yield* Effect.promise(() => NodeFSP.realpath(temporary));
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
    yield* projections.apply({
      id: EventId.make("retro-thread-created"),
      type: "thread.created",
      threadId: retro,
      occurredAt: date,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: retro,
        projectId: project,
        title: "Retro",
        providerInstanceId: instance,
        modelSelection: { instanceId: instance, model: "configured-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: root, relationshipToParent: "subagent", rootThreadId: root },
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
    let timestamp = 1000;
    const registry = yield* Registry.__testing
      .make({ now: () => timestamp, livenessWindowMs: 100 })
      .pipe(
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
    const retroCredential = yield* registry.issue({
      threadId: retro,
      providerInstanceId: instance,
    });
    const retroCaller = yield* registry.resolve(
      retroCredential.config.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    if (retroCaller === undefined) return yield* Effect.die("Missing retro credential");
    const publisher = new Policy.MissionMcpPolicyPublisher();
    publisher.publish(policyConfig());
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
      readTerminalFacts: () => Effect.die("Unused in toolkit tests"),
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
    const mcp = yield* ReportMcp.MissionRetroReportMcpService.pipe(
      Effect.provide(ReportMcp.layer({ artifactDirectory: dir })),
      Effect.provideService(MissionMcp.MissionMcpAuthorityPort, authority),
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(Receipts.OrchestrationCommandReceiptRepository, receipts),
      Effect.provideService(Events.OrchestrationEventStore, events),
    );
    return {
      dir,
      sql,
      service,
      snapshotPort,
      checkpointStore,
      analysisStore,
      reportStore,
      events,
      receipts,
      read,
      projections,
      registry,
      retroCaller,
      caller,
      publisher,
      authority,
      mcp,
      config: policyConfig(),
      expire: () => {
        timestamp += 101;
      },
    };
  });

const setup = makeSetup(keep);

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

const currentMission = (h: Handles) =>
  Effect.gen(function* () {
    return Option.getOrThrow(yield* h.service.get(mid));
  });

const commitStackOnce = (h: Handles, claimId = "resolver-claim-1") =>
  Effect.gen(function* () {
    yield* h.snapshotPort.readSnapshot(captureCommand());
    const captured = yield* h.checkpointStore.capture(captureCommand());
    if (Result.isFailure(captured)) return yield* Effect.die("capture must succeed");
    const claimed = yield* h.analysisStore.claim({
      commandId: CommandId.make(claimId),
      missionId: mid,
      checkpointId: captured.success.checkpoint.checkpointId,
      expectedRevision: 1,
      retroEpoch: 4,
    });
    if (Result.isFailure(claimed)) return yield* Effect.die("claim must succeed");
    const lease = claimed.success.analysis.lease;
    assert.isNotNull(lease, "claim must produce a lease");
    if (lease === null) return yield* Effect.die("unreachable");
    const mission = yield* currentMission(h);
    return {
      checkpointId: captured.success.checkpoint.checkpointId,
      fingerprint: captured.success.checkpoint.snapshotFingerprint,
      sourceRefs: captured.success.checkpoint.sourceRefs,
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

const prepared = (h: Handles, id = "mcp-receive") =>
  Effect.gen(function* () {
    const stack = yield* commitStackOnce(h);
    const report = reportFor(stack);
    const staged = yield* ingest(h, report);
    return { stack, report, staged, command: receiveCommand(stack, staged, report, id) };
  });

const encodeMission = Schema.encodeEffect(Schema.fromJsonString(Mission));
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const save = (h: Handles, mission: MissionValue) =>
  Effect.gen(function* () {
    const text = yield* encodeMission(mission);
    yield* h.sql`UPDATE projection_missions SET snapshot_json = ${text}, revision = ${mission.revision}, team_id = ${mission.teamId}, authority_environment_id = ${mission.authorityEnvironmentId} WHERE mission_id = ${mid}`;
  });
const durable = (h: Handles) =>
  Effect.gen(function* () {
    const mission = yield* currentMission(h);
    const events = yield* h.events.readMissionEvents(mid);
    const receipts = yield* h.sql`SELECT * FROM orchestration_command_receipts ORDER BY command_id`;
    return { mission, events, receipts };
  });
const unchanged = (h: Handles, before: Effect.Success<ReturnType<typeof durable>>) =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* durable(h), before);
  });
const noPrivateIo = <A, E, R>(task: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const reads = vi.mocked(NodeFSP.readFile).mock.calls.length;
    const links = vi.mocked(NodeFSP.link).mock.calls.length;
    const result = yield* task;
    assert.strictEqual(vi.mocked(NodeFSP.readFile).mock.calls.length, reads);
    assert.strictEqual(vi.mocked(NodeFSP.link).mock.calls.length, links);
    return result;
  });

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "retro-report-toolkit-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "retro-report-toolkit-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

interface ToolkitGate {
  readonly service: boolean;
  readonly policy: boolean;
}

// The optional registration requires the shared MCP server; each gate only
// supplies explicit service/policy dependencies and preserves that requirement.
const toolkitLayerFor = (h: Handles, gate: ToolkitGate) => {
  const optional = ReportToolkit.layerOptionalMissionRetroReportToolkit;
  if (gate.service && gate.policy) {
    return optional.pipe(
      Layer.provide(Layer.succeed(ReportMcp.MissionRetroReportMcpService, h.mcp)),
      Layer.provide(Layer.succeed(Authority.MissionMcpTrustedPolicy, h.publisher.policy)),
    );
  }
  if (gate.service) {
    return optional.pipe(
      Layer.provide(Layer.succeed(ReportMcp.MissionRetroReportMcpService, h.mcp)),
    );
  }
  if (gate.policy) {
    return optional.pipe(
      Layer.provide(Layer.succeed(Authority.MissionMcpTrustedPolicy, h.publisher.policy)),
    );
  }
  return optional;
};

// Each call (except the persistent-server test) registers over this test's
// genuine service and policy, then invokes through the in-memory server with
// a fresh registry-resolved per-request scope: no shared caller crosses
// credentials.
const callVia = (
  h: Handles,
  gate: ToolkitGate,
  scope: Invocation.McpInvocationScope,
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({ name: TOOL, arguments: args });
  }).pipe(
    Effect.provideService(Invocation.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provide(toolkitLayerFor(h, gate).pipe(Layer.provideMerge(McpServer.McpServer.layer))),
  );

// A declared service failure arrives as `isError` with its encoded payload
// as JSON text, without the Error message getter, and never as
// structuredContent. MissionMcpFailure keeps message as a schema field.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.structuredContent, undefined);
  const text = result.content[0];
  const body =
    result.isError === true && text?.type === "text" ? decodeJsonText(text.text) : undefined;
  assert.isDefined(body);
  return body as { _tag: string; code: string; message: string };
};

const failureCode = (result: McpSchema.CallToolResult) => {
  const body = declaredFailure(result);
  assert.strictEqual(body._tag, "MissionMcpFailure");
  assert.deepStrictEqual(Object.keys(body).sort(), ["_tag", "code", "message"]);
  for (const leaked of [
    "genuine source text",
    "assignmentToken",
    "account-ref",
    "descriptorBytes",
    "cause",
    "/tmp/",
    "SELECT",
    "sqlite",
    "Bearer",
    "server-policy:test",
  ]) {
    assert.notInclude(stableStringify(body), leaked);
  }
  return body.code;
};

const freshScope = (h: Handles, threadId: ThreadId) =>
  Effect.gen(function* () {
    const credential = yield* h.registry.issue({ threadId, providerInstanceId: instance });
    const scope = yield* h.registry.resolve(
      credential.config.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    if (scope === undefined) return yield* Effect.die("fresh credential did not resolve");
    return scope;
  });

const receivedOutcome = (result: McpSchema.CallToolResult) => {
  assert.strictEqual(result.isError, false);
  assert.deepStrictEqual(
    Object.keys(result.structuredContent as Record<string, unknown>).sort(),
    ["outcome", "rejection", "status"],
  );
  const body = Schema.decodeUnknownSync(ReportToolkit.MissionRetroReportReceiveResult)(result.structuredContent);
  assert.strictEqual(body.status, "received");
  assert.strictEqual(body.rejection, null);
  assert.isNotNull(body.outcome);
  return body.outcome!;
};

it.effect("receives held_partial through the toolkit with public outcome fields only", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const p = yield* prepared(h);
      const outcome = receivedOutcome(
        yield* callVia(h, { service: true, policy: true }, h.retroCaller, { ...p.command }),
      );
      assert.deepStrictEqual(Object.keys(outcome).sort(), [
        "checkpointId",
        "commandId",
        "committed",
        "disposition",
        "eventSequence",
        "missionId",
        "normalizedArtifactRef",
        "normalizedReportHash",
        "recovered",
        "sourceReportHash",
        "verdict",
      ]);
      assert.strictEqual(outcome.missionId, p.command.missionId);
      assert.strictEqual(outcome.checkpointId, p.command.checkpointId);
      assert.strictEqual(outcome.commandId, p.command.commandId);
      assert.strictEqual(outcome.committed, true);
      assert.strictEqual(outcome.recovered, false);
      assert.strictEqual(outcome.disposition, "held_partial");
      assert.strictEqual(outcome.verdict, "partial_coverage");
      assert.strictEqual(outcome.sourceReportHash, computeRetroReportHash(p.report));
      // The normalized ref is content-addressed by the semantic normalized
      // hash, never the original whole-byte SHA.
      assert.strictEqual(
        outcome.normalizedArtifactRef,
        `retro-normalized:${outcome.normalizedReportHash}`,
      );
      assert.notStrictEqual(outcome.normalizedReportHash, p.staged.originalArtifactSha);
      const text = stableStringify(outcome);
      for (const privateValue of [
        p.stack.lease.assignmentToken,
        "assignmentToken",
        "receiptRecord",
        "descriptorBytes",
        "genuine summary",
        "accountId",
        "policyRef",
        h.dir,
      ]) {
        assert.notInclude(text, privateValue);
      }
    }),
  ),
);

it.effect("replays the exact command with no duplicate events", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const p = yield* prepared(h);
      const gate = { service: true, policy: true };
      const first = receivedOutcome(yield* callVia(h, gate, h.retroCaller, { ...p.command }));
      const before = yield* durable(h);
      const eventCount = (yield* h.events.readMissionEvents(mid)).length;
      const second = receivedOutcome(yield* callVia(h, gate, h.retroCaller, { ...p.command }));
      assert.strictEqual(first.committed, true);
      assert.strictEqual(second.committed, false);
      assert.strictEqual(second.recovered, true);
      assert.strictEqual(second.eventSequence, first.eventSequence);
      assert.strictEqual((yield* h.events.readMissionEvents(mid)).length, eventCount);
      yield* unchanged(h, before);
    }),
  ),
);

it.effect("wraps a missing checkpoint as a bounded rejection", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const p = yield* prepared(h);
      const gate = { service: true, policy: true };
      const first = yield* callVia(h, gate, h.retroCaller, {
        ...p.command,
        checkpointId: "missing-checkpoint",
      });
      assert.strictEqual(first.isError, false);
      assert.deepStrictEqual(
        Object.keys(first.structuredContent as Record<string, unknown>).sort(),
        ["outcome", "rejection", "status"],
      );
      const body = yield* Schema.decodeUnknownEffect(ReportToolkit.MissionRetroReportReceiveResult)(first.structuredContent);
      assert.strictEqual(body.status, "rejected");
      assert.strictEqual(body.outcome, null);
      assert.deepStrictEqual(body.rejection, {
        category: "report_rejected",
        code: "checkpoint_missing",
      });
      const second = yield* callVia(h, gate, h.retroCaller, {
        ...p.command,
        checkpointId: "missing-checkpoint",
      });
      assert.deepStrictEqual(second.structuredContent, first.structuredContent);
      assert.strictEqual((yield* currentMission(h)).revision, p.stack.revision);
    }),
  ),
);

it.effect("denies wrong-role, non-thread, and capability-less callers with no canonical writes", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const p = yield* prepared(h);
      const gate = { service: true, policy: true };
      const before = yield* durable(h);
      assert.strictEqual(
        failureCode(
          yield* noPrivateIo(callVia(h, gate, h.caller, { ...p.command })),
        ),
        "scope_denied",
      );
      const oauth: Invocation.McpInvocationScope = {
        ...h.retroCaller,
        thread: undefined,
        client: { sessionId: "oauth", label: "oauth", runtimeModeCeiling: "full-access" },
      };
      assert.strictEqual(
        failureCode(yield* noPrivateIo(callVia(h, gate, oauth, { ...p.command }))),
        "thread_credential_required",
      );
      assert.strictEqual(
        failureCode(
          yield* noPrivateIo(
            callVia(
              h,
              gate,
              { ...h.retroCaller, capabilities: new Set<Invocation.McpCapability>() },
              { ...p.command },
            ),
          ),
        ),
        "capability_denied",
      );
      yield* unchanged(h, before);
    }),
  ),
);

it.effect("denies a revoked session, then serves a freshly resolved retro scope", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const p = yield* prepared(h);
      const gate = { service: true, policy: true };
      const first = receivedOutcome(yield* callVia(h, gate, h.retroCaller, { ...p.command }));
      yield* h.registry.revokeProviderSession(h.retroCaller.thread.providerSessionId);
      assert.strictEqual(
        failureCode(yield* callVia(h, gate, h.retroCaller, { ...p.command })),
        "scope_denied",
      );
      const served = receivedOutcome(
        yield* callVia(h, gate, yield* freshScope(h, retro), { ...p.command }),
      );
      assert.strictEqual(served.committed, false);
      assert.strictEqual(served.recovered, true);
      assert.strictEqual(served.eventSequence, first.eventSequence);
    }),
  ),
);

it.effect("denies a stale retro epoch with no canonical writes", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const p = yield* prepared(h);
      const gate = { service: true, policy: true };
      assert.strictEqual(
        failureCode(
          yield* noPrivateIo(callVia(h, gate, h.retroCaller, { ...p.command, retroEpoch: 3 })),
        ),
        "scope_denied",
      );
      const current = yield* currentMission(h);
      yield* save(h, {
        ...current,
        managers: { ...current.managers, retro: { threadId: retro, epoch: 5 } },
      });
      const before = yield* durable(h);
      assert.strictEqual(
        failureCode(yield* noPrivateIo(callVia(h, gate, h.retroCaller, { ...p.command }))),
        "scope_denied",
      );
      yield* unchanged(h, before);
    }),
  ),
);

it.effect("denies through the actual service under an explicitly disabled policy", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const p = yield* prepared(h);
      const gate = { service: true, policy: true };
      assert.strictEqual(
        (yield* callVia(h, gate, h.retroCaller, { ...p.command })).isError,
        false,
      );
      h.publisher.disable();
      assert.strictEqual(
        failureCode(yield* callVia(h, gate, h.retroCaller, { ...p.command })),
        "authority_unavailable",
      );
      h.publisher.publish(h.config);
      const replay = receivedOutcome(
        yield* callVia(h, gate, h.retroCaller, { ...p.command }),
      );
      assert.strictEqual(replay.recovered, true);
    }),
  ),
);

it.effect("rejects excess and unsafe input at the SDK before private I/O", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const p = yield* prepared(h);
      const gate = { service: true, policy: true };
      const before = yield* durable(h);
      const excess = yield* Effect.flip(
        callVia(h, gate, h.retroCaller, { ...p.command, unexpected: true }),
      );
      assert.strictEqual(excess._tag, "InvalidParams");
      for (const args of [
        { ...p.command, missionId: "m".repeat(513) },
        { ...p.command, commandId: "" },
        { ...p.command, originalArtifactSha: "bad" },
        { ...p.command, claimedSourceReportHash: "z".repeat(64) },
        { ...p.command, retroEpoch: -1 },
        { ...p.command, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
        { ...p.command, expectedRevision: 1.5 },
      ]) {
        const rejected = yield* Effect.flip(noPrivateIo(callVia(h, gate, h.retroCaller, args)));
        assert.strictEqual(rejected._tag, "InvalidParams");
      }
      yield* unchanged(h, before);
      assert.strictEqual(
        (yield* callVia(h, gate, h.retroCaller, { ...p.command })).isError,
        false,
      );
    }),
  ),
);

it.effect("keeps the tool absent without an injected service or trusted policy", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const p = yield* prepared(h);
      const before = yield* durable(h);
      for (const gate of [
        { service: false, policy: true },
        { service: true, policy: false },
      ] as const) {
        const refused = yield* Effect.flip(callVia(h, gate, h.retroCaller, { ...p.command }));
        assert.strictEqual(refused._tag, "InvalidParams");
      }
      yield* unchanged(h, before);
      assert.strictEqual(
        (yield* callVia(h, { service: true, policy: true }, h.retroCaller, { ...p.command }))
          .isError,
        false,
      );
    }),
  ),
);

it.effect("one persistent server isolates alternating retro and delivery scopes per request", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const p = yield* prepared(h);
      const persistent = toolkitLayerFor(h, { service: true, policy: true }).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
      );
      const run = (scope: Invocation.McpInvocationScope) =>
        Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          return yield* server.callTool({ name: TOOL, arguments: { ...p.command } });
        }).pipe(
          Effect.provideService(Invocation.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      yield* Effect.gen(function* () {
        const eventCount = (yield* h.events.readMissionEvents(mid)).length;
        const first = receivedOutcome(yield* run(yield* freshScope(h, retro)));
        assert.strictEqual(first.committed, true);
        assert.strictEqual(
          failureCode(yield* run(yield* freshScope(h, root))),
          "scope_denied",
        );
        const last = receivedOutcome(yield* run(yield* freshScope(h, retro)));
        assert.strictEqual(last.committed, false);
        assert.strictEqual(last.recovered, true);
        assert.strictEqual(last.eventSequence, first.eventSequence);
        assert.strictEqual((yield* h.events.readMissionEvents(mid)).length, eventCount + 1);
      }).pipe(Effect.provide(persistent));
    }),
  ),
);
