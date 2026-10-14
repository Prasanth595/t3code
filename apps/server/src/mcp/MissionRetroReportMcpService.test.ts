// @effect-diagnostics nodeBuiltinImport:off -- native offline source-resolver integration tests.
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
  OrchestrationV2AppThread,
  MessageId,
  RunId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
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

const makeSetup = (sanitize: Manifest.MissionRetroSourceSanitizer) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "report-mcp-" });
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
    const hooks: {
      policy?: Effect.Effect<void>;
      live?: Effect.Effect<void>;
      insert?: Effect.Effect<void>;
      event?: Effect.Effect<void>;
      lookup?: Effect.Effect<void>;
    } = {};
    const liveRegistry = {
      ...registry,
      isActiveScope: (scope: Invocation.McpThreadInvocationScope) =>
        Effect.gen(function* () {
          if (hooks.live !== undefined) yield* hooks.live;
          return yield* registry.isActiveScope!(scope);
        }),
    };
    const policyReader = {
      current: publisher.policy.current,
      read: Effect.gen(function* () {
        if (hooks.policy !== undefined) yield* hooks.policy;
        return yield* publisher.policy.read;
      }),
    };
    const authority = yield* MissionMcp.MissionMcpAuthorityPort.pipe(
      Effect.provide(Authority.layer),
      Effect.provideService(Registry.McpSessionRegistry, liveRegistry),
      Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
      Effect.provideService(Authority.MissionMcpTrustedPolicy, policyReader),
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
    const observedReceipts = {
      ...receipts,
      insertIfAbsent: (receipt: Receipts.OrchestrationCommandReceipt) =>
        Effect.gen(function* () {
          const result = yield* receipts.insertIfAbsent(receipt);
          if (
            receipt.commandType === ReportStore.MISSION_RETRO_REPORT_RECEIVE_COMMAND_TYPE &&
            hooks.insert !== undefined
          )
            yield* hooks.insert;
          return result;
        }),
      getByCommandId: (input: { readonly commandId: CommandId }) =>
        Effect.gen(function* () {
          const result = yield* receipts.getByCommandId(input);
          if (
            Option.isSome(yield* Effect.serviceOption(sql.transactionService)) &&
            hooks.lookup !== undefined
          )
            yield* hooks.lookup;
          return result;
        }),
    };
    const observedEvents = {
      ...events,
      appendMissionEvent: (event: Parameters<typeof events.appendMissionEvent>[0]) =>
        Effect.gen(function* () {
          const result = yield* events.appendMissionEvent(event);
          if (event.type === "mission.retro-report-received" && hooks.event !== undefined)
            yield* hooks.event;
          return result;
        }),
    };
    const configuration = { artifactDirectory: dir };
    const mcpLayer = ReportMcp.layer(configuration);
    const buildMcp = (port = authority, owningSql = sql) =>
      ReportMcp.MissionRetroReportMcpService.pipe(
        Effect.provide(mcpLayer),
        Effect.provideService(MissionMcp.MissionMcpAuthorityPort, port),
        Effect.provideService(SqlClient.SqlClient, owningSql),
        Effect.provideService(Receipts.OrchestrationCommandReceiptRepository, observedReceipts),
        Effect.provideService(Events.OrchestrationEventStore, observedEvents),
      );
    const mcp = yield* buildMcp();
    return {
      dir,
      sql,
      service,
      snapshotPort,
      checkpointStore,
      analysisStore,
      reportStore,
      resolver,
      events,
      receipts,
      read,
      projections,
      registry,
      retroCaller,
      caller,
      publisher,
      authority,
      hooks,
      mcp,
      buildMcp,
      configuration,
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

const prepared = (h: Handles, id = "mcp-receive") =>
  Effect.gen(function* () {
    const stack = yield* commitStack(h);
    const report = reportFor(stack);
    const staged = yield* ingest(h, report);
    return { stack, report, staged, command: receiveCommand(stack, staged, report, id) };
  });

const encodeMission = Schema.encodeEffect(Schema.fromJsonString(Mission));
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
const failure = <A>(
  effect: Effect.Effect<A, MissionMcp.MissionMcpFailure>,
  code = "scope_denied",
) =>
  Effect.gen(function* () {
    const error = yield* effect.pipe(Effect.flip);
    assert.strictEqual(error.code, code);
    const text = stableStringify(error);
    for (const secret of [
      "genuine source text",
      "assignmentToken",
      "account-ref",
      "descriptorBytes",
      "cause",
      "/tmp/",
      "/private/",
    ])
      assert.notInclude(text, secret);
    return error;
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

it.effect(
  "current RETRO receives real capture-origin-v2 artifacts as held_partial, replays, and aliases exact bytes",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const p = yield* prepared(h);
        const outcome = ok(yield* h.mcp.receive(h.retroCaller, p.command));
        assert.isTrue(outcome.committed);
        assert.strictEqual(outcome.disposition, "held_partial");
        assert.strictEqual(outcome.verdict, "partial_coverage");
        assert.strictEqual(outcome.sourceReportHash, computeRetroReportHash(p.report));
        const before = yield* durable(h);
        assert.strictEqual(before.mission.revision, p.stack.revision + 1);
        assert.isFalse(before.mission.execution!.retroReportReceipts![0]!.coverageFull);
        const metadata = yield* h.resolver.resolve({
          command: { ...p.command, expectedRevision: before.mission.revision },
          originalSha: p.staged.originalArtifactSha,
          report: p.report,
        });
        assert.deepStrictEqual(metadata.coverage.readReceipts, []);
        assert.deepStrictEqual(metadata.coverage.trustedSkillLoads, []);
        const replay = ok(yield* h.mcp.receive(h.retroCaller, p.command));
        assert.isFalse(replay.committed);
        assert.isTrue(replay.recovered);
        assert.strictEqual(replay.eventSequence, outcome.eventSequence);
        yield* unchanged(h, before);
        const alias = ok(
          yield* h.mcp.receive(h.retroCaller, {
            ...p.command,
            commandId: CommandId.make("exact-alias"),
            expectedRevision: before.mission.revision,
          }),
        );
        assert.isFalse(alias.committed);
        assert.strictEqual(alias.eventSequence, outcome.eventSequence);
        assert.strictEqual((yield* currentMission(h)).revision, before.mission.revision);
        const text = stableStringify(outcome);
        for (const privateValue of [
          p.stack.lease.assignmentToken,
          "assignmentToken",
          "receiptRecord",
          "descriptorBytes",
          "genuine summary",
          "policyRef",
          "accountId",
          h.dir,
        ])
          assert.notInclude(text, privateValue);
        yield* rollbackAlias(h, {
          ...p.command,
          commandId: CommandId.make("revoked-exact-alias"),
          expectedRevision: before.mission.revision,
        });
        // A completed, authorized record stays returned after a later revocation.
        yield* h.registry.revokeThread(retro);
        assert.strictEqual(outcome.disposition, "held_partial");
      }),
    ),
);

it.effect(
  "changed source bytes are quarantined and repeated variants alias without replacing the accepted hash",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const p = yield* prepared(h);
        const first = ok(yield* h.mcp.receive(h.retroCaller, p.command));
        const report = reportFor(p.stack, { summary: "changed source" });
        const staged = yield* ingest(h, report);
        const command = receiveCommand(
          { ...p.stack, revision: p.stack.revision + 1 },
          staged,
          report,
          "quarantine",
        );
        const held = ok(yield* h.mcp.receive(h.retroCaller, command));
        assert.isTrue(held.committed);
        assert.strictEqual(held.disposition, "held_conflict");
        assert.notStrictEqual(held.sourceReportHash, first.sourceReportHash);
        const current = yield* currentMission(h);
        assert.strictEqual(
          current.execution!.retroReportReceipts![0]!.sourceReportHash,
          first.sourceReportHash,
        );
        assert.strictEqual(current.execution!.retroReportReceipts![0]!.quarantine.length, 1);
        const alias = ok(
          yield* h.mcp.receive(h.retroCaller, {
            ...command,
            commandId: CommandId.make("quarantine-alias"),
            expectedRevision: current.revision,
          }),
        );
        assert.isFalse(alias.committed);
        assert.strictEqual(alias.eventSequence, held.eventSequence);
        assert.strictEqual((yield* currentMission(h)).revision, current.revision);
        yield* rollbackAlias(h, {
          ...command,
          commandId: CommandId.make("revoked-quarantine-alias"),
          expectedRevision: current.revision,
        });
        // A fresh conflicting source must also roll back its event/projection writes.
        const anotherReport = reportFor(p.stack, { summary: "another conflicting source" });
        const another = yield* ingest(h, anotherReport);
        yield* rollbackAlias(
          h,
          receiveCommand(
            { ...p.stack, revision: current.revision },
            another,
            anotherReport,
            "revoked-quarantine",
          ),
        );
      }),
    ),
);

it.effect(
  "documented rejection stays a Result with finite metadata on first receive and exact rejected replay",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const p = yield* prepared(h);
        const command = { ...p.command, checkpointId: "missing-checkpoint" };
        const first = yield* h.mcp.receive(h.retroCaller, command);
        assert.isTrue(Result.isFailure(first));
        if (Result.isFailure(first))
          assert.deepStrictEqual(first.failure, {
            category: "report_rejected",
            code: "checkpoint_missing",
          });
        const before = yield* durable(h);
        const second = yield* h.mcp.receive(h.retroCaller, command);
        assert.deepStrictEqual(second, first);
        yield* unchanged(h, before);
        assert.strictEqual(before.mission.revision, p.stack.revision);
        const report = reportFor(p.stack, {
          sourceRefs: [
            ...p.stack.sourceRefs,
            {
              rootRef: sourceRoot,
              chunkRef: "foreign",
              chunkHash: "d".repeat(64),
              coveredFromInclusive: 0,
              coveredToExclusive: 1,
            },
          ],
        });
        const staged = yield* ingest(h, report);
        const result = yield* h.mcp.receive(
          h.retroCaller,
          receiveCommand(p.stack, staged, report, "bad-ref"),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result))
          assert.deepStrictEqual(result.failure, {
            category: "reconciliation_rejected",
            code: "unknown_source_ref",
          });
        yield* failure(
          h.mcp.receive(h.retroCaller, {
            ...p.command,
            commandId: CommandId.make("missing-original"),
            originalArtifactRef: `retro-original:${"e".repeat(64)}`,
          }),
          "unavailable",
        );
      }),
    ),
);

it.effect(
  "strict receive accepts only the eight typed leaves and rejects caller authority, body, path, and unknown JSON before private I/O",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const p = yield* prepared(h);
        const before = yield* durable(h);
        for (const key of [
          "teamId",
          "environmentId",
          "controllerThreadId",
          "company",
          "profile",
          "path",
          "authHandle",
          "report",
          "descriptorBytes",
          "transactionGuard",
          "extra",
        ]) {
          yield* noPrivateIo(
            failure(
              h.mcp.receive(h.retroCaller, { ...p.command, [key]: "forbidden" }),
              "invalid_request",
            ),
          );
        }
        for (const value of [
          null,
          [],
          "{}",
          { ...p.command, retroEpoch: -1 },
          { ...p.command, originalArtifactSha: "bad" },
        ])
          yield* noPrivateIo(failure(h.mcp.receive(h.retroCaller, value), "invalid_request"));
        yield* unchanged(h, before);
      }),
    ),
);

it.effect(
  "delivery-only, external OAuth, missing capability, foreign environment, and altered full registry scopes deny before private I/O",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const p = yield* prepared(h);
        const before = yield* durable(h);
        for (const [scope, code] of [
          [h.caller, "scope_denied"],
          [
            {
              ...h.retroCaller,
              thread: undefined,
              client: {
                sessionId: "external",
                label: "external",
                runtimeModeCeiling: "full-access" as const,
              },
            },
            "thread_credential_required",
          ],
          [
            { ...h.retroCaller, capabilities: new Set<Invocation.McpCapability>() },
            "capability_denied",
          ],
          [{ ...h.retroCaller, environmentId: EnvironmentId.make("foreign") }, "scope_denied"],
          [{ ...h.retroCaller, requestNamespace: "forged" }, "scope_denied"],
          [{ ...h.retroCaller, issuedAt: h.retroCaller.issuedAt + 1 }, "scope_denied"],
          [
            { ...h.retroCaller, thread: { ...h.retroCaller.thread!, providerSessionId: "forged" } },
            "scope_denied",
          ],
        ] as const)
          yield* noPrivateIo(failure(h.mcp.receive(scope, p.command), code));
        yield* unchanged(h, before);
      }),
    ),
);

it.effect(
  "disabled, unverified, missing, and stale current policy fail closed before private artifact work",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const p = yield* prepared(h);
        const before = yield* durable(h);
        h.publisher.disable();
        yield* noPrivateIo(
          failure(h.mcp.receive(h.retroCaller, p.command), "authority_unavailable"),
        );
        const current = { ...policyConfig(), revision: "test-only-current", enabled: true };
        for (const [reader, code] of [
          [undefined, "authority_unavailable"],
          [{ read: Effect.succeed(current) }, "authority_unavailable"],
          [
            {
              read: Effect.succeed({ ...current, companyVerified: false }),
              current: () => current,
            },
            "authority_unavailable",
          ],
          [
            { read: Effect.succeed(current), current: () => ({ ...current, revision: "changed" }) },
            "scope_denied",
          ],
        ] as const) {
          const build = MissionMcp.MissionMcpAuthorityPort.pipe(
            Effect.provide(Authority.layer),
            Effect.provideService(Registry.McpSessionRegistry, h.registry),
            Effect.provideService(ServerEnvironment.ServerEnvironment, {
              getEnvironmentId: Effect.succeed(env),
              getDescriptor: Effect.die("unused"),
            }),
          );
          const port = yield* reader === undefined
            ? build
            : build.pipe(Effect.provideService(Authority.MissionMcpTrustedPolicy, reader));
          const service = yield* h.buildMcp(port);
          yield* noPrivateIo(failure(service.receive(h.retroCaller, p.command), code));
        }
        yield* unchanged(h, before);
      }),
    ),
);

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

it.effect(
  "canonical foreign team, deleted project, changed project root, excluded project, and broken lineage cannot authorize RETRO",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const p = yield* prepared(h);
        const original = yield* currentMission(h);
        yield* save(h, { ...original, teamId: TeamId.make("foreign-team") });
        yield* noPrivateIo(failure(h.mcp.receive(h.retroCaller, p.command)));
        yield* save(h, original);
        yield* h.sql`UPDATE projection_projects SET deleted_at = ${now} WHERE project_id = ${project}`;
        yield* noPrivateIo(failure(h.mcp.receive(h.retroCaller, p.command)));
        yield* h.sql`UPDATE projection_projects SET deleted_at = NULL, workspace_root = '/tmp/foreign' WHERE project_id = ${project}`;
        yield* noPrivateIo(failure(h.mcp.receive(h.retroCaller, p.command)));
        yield* h.sql`UPDATE projection_projects SET workspace_root = '/tmp/resolver-project' WHERE project_id = ${project}`;
        h.publisher.publish({ ...policyConfig(), allowedProjectIds: [ProjectId.make("other")] });
        yield* noPrivateIo(failure(h.mcp.receive(h.retroCaller, p.command)));
        h.publisher.publish(policyConfig());
        const encodeThread = Schema.encodeEffect(OrchestrationV2AppThread);
        const thread = yield* encodeThread(yield* h.projections.getThread(retro));
        const text = stableStringify({
          ...thread,
          lineage: {
            parentThreadId: root,
            relationshipToParent: "subagent",
            rootThreadId: "missing-root",
          },
        });
        yield* h.sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${text} WHERE thread_id = ${retro}`;
        yield* noPrivateIo(failure(h.mcp.receive(h.retroCaller, p.command), "unavailable"));
      }),
    ),
);

it.effect(
  "old managers and wrong epochs cannot read accepted or rejected replays even with the original command fence",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const p = yield* prepared(h);
        ok(yield* h.mcp.receive(h.retroCaller, p.command));
        const rejected = {
          ...p.command,
          commandId: CommandId.make("rejected-old"),
          checkpointId: "missing",
        };
        yield* h.mcp.receive(h.retroCaller, rejected);
        yield* noPrivateIo(failure(h.mcp.receive(h.retroCaller, { ...p.command, retroEpoch: 3 })));
        const current = yield* currentMission(h);
        yield* save(h, {
          ...current,
          managers: { ...current.managers, retro: { threadId: root, epoch: 5 } },
        });
        const before = yield* durable(h);
        for (const command of [p.command, rejected])
          yield* noPrivateIo(failure(h.mcp.receive(h.retroCaller, command)));
        yield* unchanged(h, before);
      }),
    ),
);

it.effect(
  "plain facts, copied guards, wrong SQL, request keys, and altered commands never authorize private I/O",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const p = yield* prepared(h);
        const before = yield* durable(h);
        const fake = MissionMcp.MissionMcpAuthorityPort.of({
          resolve: () =>
            Effect.succeed({
              company: "nofun",
              companyVerified: true,
              bindingVerified: true,
              ...retroAuthority,
            }),
        });
        yield* noPrivateIo(failure((yield* h.buildMcp(fake)).receive(h.retroCaller, p.command)));
        for (const mode of ["copied", "key", "command", "sql", "authority"] as const) {
          const port = MissionMcp.MissionMcpAuthorityPort.of({
            resolve: (request) =>
              Effect.gen(function* () {
                if (request.operation !== "retro-report-receive")
                  return yield* Effect.die("unexpected request");
                const facts = yield* h.authority.resolve(
                  mode === "key"
                    ? { ...request, requestKey: {} }
                    : mode === "command"
                      ? {
                          ...request,
                          command: { ...request.command, claimedSourceReportHash: "d".repeat(64) },
                        }
                      : request,
                );
                return mode === "copied"
                  ? { ...facts, transactionGuard: { ...facts.transactionGuard! } }
                  : mode === "authority"
                    ? { ...facts, teamId: TeamId.make("foreign") }
                    : facts;
              }),
          });
          const sql = mode === "sql" ? new Proxy(h.sql, {}) : h.sql;
          const service = yield* h.buildMcp(port, sql);
          yield* noPrivateIo(failure(service.receive(h.retroCaller, p.command)));
        }
        yield* unchanged(h, before);
      }),
    ),
);

it.effect("registry current-scope checks never renew expired credentials", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const p = yield* prepared(h);
      ok(yield* h.mcp.receive(h.retroCaller, p.command));
      ok(yield* h.mcp.receive(h.retroCaller, p.command));
      h.expire();
      yield* noPrivateIo(failure(h.mcp.receive(h.retroCaller, p.command)));
    }),
  ),
);

it.effect("scope, full command, and root directory options are detached before policy I/O", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const p = yield* prepared(h);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let gate = true;
      h.hooks.policy = Effect.gen(function* () {
        if (!gate) return;
        gate = false;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
      });
      const scope = {
        ...h.retroCaller,
        capabilities: new Set(h.retroCaller.capabilities),
        thread: { ...h.retroCaller.thread! },
      };
      const command = { ...p.command };
      const child = yield* Effect.forkChild(h.mcp.receive(scope, command));
      yield* reached(entered, child);
      command.commandId = CommandId.make("mutated-command");
      command.retroEpoch = 88;
      scope.thread.threadId = root;
      scope.capabilities.clear();
      h.configuration.artifactDirectory = "/unusable/mutated";
      yield* Deferred.succeed(release, undefined);
      const result = ok(yield* Fiber.join(child));
      assert.strictEqual(result.commandId, p.command.commandId);
      assert.strictEqual(result.disposition, "held_partial");
      assert.isTrue(
        Option.isNone(yield* h.receipts.getByCommandId({ commandId: command.commandId })),
      );
    }),
  ),
);

const reached = <A, E>(entered: Deferred.Deferred<void>, child: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    const enteredFirst = yield* Effect.race(
      Deferred.await(entered).pipe(Effect.as(true)),
      Fiber.await(child).pipe(Effect.as(false)),
    );
    assert.isTrue(enteredFirst, "required native hook must enter before receive completes");
  });

const fsRace = (kind: "policy" | "session" | "role") =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const p = yield* prepared(h);
      const original = yield* currentMission(h);
      const before = yield* durable(h);
      const actual = yield* Effect.promise(() =>
        vi.importActual<typeof NodeFSP>("node:fs/promises"),
      );
      const artifactPath = Artifacts.artifactPathForRef(
        h.dir,
        p.command.originalArtifactRef,
        "retro-original",
      );
      if (artifactPath === null) return yield* Effect.die("invalid fixture ref");
      const exactPath = yield* Effect.promise(() => NodeFSP.realpath(artifactPath));
      const atRead = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const gated = async (...args: Array<unknown>): Promise<unknown> => {
        if (String(args[0]) === exactPath) {
          atRead.resolve();
          await release.promise;
        }
        return (actual.readFile as (...call: Array<unknown>) => Promise<unknown>)(...args);
      };
      yield* Effect.gen(function* () {
        vi.mocked(NodeFSP.readFile).mockImplementation(gated as never);
        const entered = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          Effect.promise(() => atRead.promise).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
          ),
        );
        const child = yield* Effect.forkChild(
          h.mcp.receive(h.retroCaller, p.command).pipe(Effect.result),
        );
        yield* reached(entered, child);
        if (kind === "policy") h.publisher.revoke();
        if (kind === "session") yield* h.registry.revokeThread(retro);
        if (kind === "role")
          yield* save(h, {
            ...original,
            managers: { ...original.managers, retro: { threadId: root, epoch: 5 } },
          });
        release.resolve();
        const result = yield* Fiber.join(child);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.strictEqual(result.failure.code, "scope_denied");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            release.resolve();
            vi.mocked(NodeFSP.readFile).mockImplementation(actual.readFile as never);
          }),
        ),
      );
      if (kind === "role") yield* save(h, original);
      yield* unchanged(h, before);
    }),
  );
it.effect.each(["policy", "session", "role"] as const)(
  "%s revoked during the exact realpath read prevents SQL receipts and events",
  (kind) => fsRace(kind),
);

const sqlRace = (
  kind:
    | "accepted-insert"
    | "event"
    | "rejected-insert"
    | "accepted-replay"
    | "rejected-replay"
    | "final-live",
  changeRole = false,
) =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const p = yield* prepared(h);
      const rejected = kind.startsWith("rejected");
      const command = rejected ? { ...p.command, checkpointId: "missing" } : p.command;
      if (kind.endsWith("replay")) yield* h.mcp.receive(h.retroCaller, command);
      const before = yield* durable(h);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let armed = true;
      const wait = Effect.gen(function* () {
        if (!armed) return;
        armed = false;
        assert.isTrue(
          Option.isSome(yield* Effect.serviceOption(h.sql.transactionService)),
          "owning SQL transaction must be active",
        );
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
      });
      if (kind === "event") h.hooks.event = wait;
      else if (kind.endsWith("replay")) h.hooks.lookup = wait;
      else if (kind === "final-live")
        h.hooks.insert = Effect.sync(() => {
          h.hooks.live = wait;
        });
      else
        h.hooks.insert = changeRole
          ? Effect.gen(function* () {
              const current = yield* currentMission(h);
              yield* save(h, {
                ...current,
                managers: { ...current.managers, retro: { threadId: root, epoch: 5 } },
              });
              yield* wait;
            }).pipe(Effect.orDie)
          : wait;
      const child = yield* Effect.forkChild(
        h.mcp.receive(h.retroCaller, command).pipe(Effect.result),
      );
      yield* reached(entered, child);
      if (!changeRole) {
        if (kind === "event" || kind === "accepted-replay") yield* h.registry.revokeThread(retro);
        else h.publisher.revoke();
      }
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(child);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.strictEqual(result.failure.code, "scope_denied");
      delete h.hooks.insert;
      delete h.hooks.event;
      delete h.hooks.lookup;
      delete h.hooks.live;
      yield* unchanged(h, before);
    }),
  );
it.effect.each([
  "accepted-insert",
  "event",
  "rejected-insert",
  "accepted-replay",
  "rejected-replay",
  "final-live",
] as const)("%s: native revocation in owning SQL rolls back or denies every return path", (kind) =>
  Effect.gen(function* () {
    yield* sqlRace(kind);
    if (kind === "accepted-insert" || kind === "rejected-insert") yield* sqlRace(kind, true);
  }),
);

const rollbackAlias = (h: Handles, command: ReportStore.MissionRetroReportReceiveCommand) =>
  Effect.gen(function* () {
    const before = yield* durable(h);
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    h.hooks.insert = Effect.gen(function* () {
      assert.isTrue(Option.isSome(yield* Effect.serviceOption(h.sql.transactionService)));
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
    });
    const child = yield* Effect.forkChild(
      h.mcp.receive(h.retroCaller, command).pipe(Effect.result),
    );
    yield* reached(entered, child);
    h.publisher.revoke();
    yield* Deferred.succeed(release, undefined);
    const result = yield* Fiber.join(child);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.strictEqual(result.failure.code, "scope_denied");
    delete h.hooks.insert;
    h.publisher.publish(policyConfig());
    yield* unchanged(h, before);
  });


it.effect("archived historical lineage preserves current RETRO authority while archived caller is denied", () =>
  scoped(Effect.gen(function* () {
    const h = yield* setup;
    const p = yield* prepared(h);
    const encode = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2AppThread));
    const ancestor = yield* h.projections.getThread(root);
    const archivedRoot = yield* encode({ ...ancestor, archivedAt: DateTime.makeUnsafe(now) });
    yield* h.sql`UPDATE orchestration_v2_projection_threads SET archived_at = ${now}, payload_json = ${archivedRoot} WHERE thread_id = ${root}`;
    const outcome = ok(yield* h.mcp.receive(h.retroCaller, p.command));
    assert.strictEqual(outcome.disposition, "held_partial");
    const before = yield* durable(h);
    const current = yield* h.projections.getThread(retro);
    const archivedCaller = yield* encode({ ...current, archivedAt: DateTime.makeUnsafe(now) });
    yield* h.sql`UPDATE orchestration_v2_projection_threads SET archived_at = ${now}, payload_json = ${archivedCaller} WHERE thread_id = ${retro}`;
    yield* noPrivateIo(failure(h.mcp.receive(h.retroCaller, p.command)));
    yield* unchanged(h, before);
  })),
);
