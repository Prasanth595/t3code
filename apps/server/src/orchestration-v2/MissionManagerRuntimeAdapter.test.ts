// @effect-diagnostics nodeBuiltinImport:off -- test hashes fixture evidence and uses a private temp artifact root.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NetAddress from "effect/net/NetAddress";
import {
  CommandId,
  EnvironmentId,
  Mission,
  MissionId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Subagent,
  NodeId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpServer } from "effect/http";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as PersistedReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as PersistedEvents from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { managerReservationState } from "../../../../packages/contracts/src/missionManagerTransfer.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Artifacts from "./MissionManagerHandoffArtifacts.ts";
import * as Lifecycle from "./MissionManagerLifecycleStore.ts";
import { evaluateManagerRotation, type RotationSafeBoundary } from "./MissionManagerRotation.ts";
import * as RuntimeAdapter from "./MissionManagerRuntimeAdapter.ts";
import * as TransferStore from "./MissionManagerTransferStore.ts";
import * as MissionService from "./MissionService.ts";
import type { ProviderAdapterV2SessionRuntime, ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

/**
 * The adapter against the real services it composes: memory SQLite with the
 * genuine mission, reserve and lifecycle stores, thread management and
 * launch, the provider session manager (over a fake provider process), and
 * the MCP credential registry. Only these are fixtures: the two private
 * authority/trusted-facts ports the stores require, the optional boundary
 * facts port (integration, GUI, fence), the provider process itself, and the
 * successor model's reply. Nothing here is live runtime proof, and no test
 * touches a real session, port, dev server or the user's database.
 */

const TIMEZONE = "America/New_York";
const NOW_ISO = "2026-10-14T12:00:00.000Z";
const BASE_COMMIT = "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d";
const AUTHORITY = { source: "mission-council", ref: "decision-2026-001" } as const;
const MISSION_ID = "mission-runtime";
const projectId = ProjectId.make("project:runtime-adapter");

const INCUMBENT = ThreadId.make("thread:manager:incumbent");
const WORKER = ThreadId.make("thread:manager:worker");
const BYSTANDER = ThreadId.make("thread:manager:bystander");
const INCUMBENT_RUN = "run:manager:incumbent:1";
const EARLIER_THREAD = "thread:manager:earlier";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} satisfies ModelSelection;
const CODEX = ProviderDriverKind.make("codex");
const EXCLUSIVE_CAPABILITIES: OrchestrationV2ProviderCapabilities = {
  ...CodexProviderCapabilitiesV2,
  sessions: {
    ...CodexProviderCapabilitiesV2.sessions,
    supportsMultipleProviderThreadsPerSession: false,
  },
};

const sha = (label: string): string => NodeCrypto.createHash("sha256").update(label).digest("hex");
const decodeMission = Schema.decodeUnknownSync(Mission);

type Role = "delivery" | "retro";
type Step = Lifecycle.ManagerLifecycleStep;
type RFacts = TransferStore.ManagerTrustedFacts;

interface World {
  authorityOk: boolean;
  reserveFacts: RFacts | null;
  /** What the optional boundary port reports; null is the port saying it does not know. */
  boundary: RuntimeAdapter.ManagerQuiesceBoundary | null;
  routingReady: boolean | null;
  /** Provider session ids whose runtime reports pending background work. */
  background: Set<string>;
  /** Provider session ids whose stop (release or detach) is made to fail. */
  failStopFor: Set<string>;
  shared: boolean;
  opened: Array<string>;
  closed: Array<string>;
  setupRuns: number;
  folderClaims: number;
}

const quietBoundary = (): RuntimeAdapter.ManagerQuiesceBoundary => ({
  integrationRunning: false,
  guiOwned: false,
  unmanagedShellWrites: "none",
  sharedWrites: "none",
  fence: null,
});

const makeWorld = (shared: boolean): World => ({
  authorityOk: true,
  reserveFacts: null,
  boundary: quietBoundary(),
  routingReady: true,
  background: new Set(),
  failStopFor: new Set(),
  shared,
  opened: [],
  closed: [],
  setupRuns: 0,
  folderClaims: 0,
});

// ----------------------------------------------------------------- provider

const makeProviderAdapter = (world: World): ProviderAdapterV2Shape => {
  const capabilities = world.shared ? CodexProviderCapabilitiesV2 : EXCLUSIVE_CAPABILITIES;
  return {
    instanceId: modelSelection.instanceId,
    driver: CODEX,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        world.opened.push(String(input.providerSessionId));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            world.closed.push(String(input.providerSessionId));
          }),
        );
        return {
          instanceId: modelSelection.instanceId,
          driver: CODEX,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver: CODEX,
            providerInstanceId: modelSelection.instanceId,
            status: "ready" as const,
            cwd: process.cwd(),
            model: modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.never,
          hasPendingBackgroundWork: Effect.sync(() =>
            world.background.has(String(input.providerSessionId)),
          ),
          ensureThread: () => Effect.die("unused"),
          resumeThread: (threadInput) => Effect.succeed(threadInput.providerThread),
          startTurn: () => Effect.void,
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          unloadThread: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        } satisfies ProviderAdapterV2SessionRuntime;
      }),
  };
};

// ------------------------------------------------------------------ fixtures

const missionFixture = (role: Role) =>
  decodeMission({
    schemaVersion: 1,
    id: MISSION_ID,
    revision: 0,
    teamId: "team-1",
    authorityEnvironmentId: "env-1",
    projectTimezone: TIMEZONE,
    bindings: [
      {
        projectId,
        workspaceRoot: "/tmp/project",
        baseCommit: BASE_COMMIT,
        ancestry: [BASE_COMMIT],
      },
    ],
    intent: {
      outcome: "Rotate the manager through the runtime adapter.",
      scope: ["delivery"],
      exclusions: [],
      authorityRefs: [{ ...AUTHORITY }],
      acceptanceCriteria: [{ id: "ac-1", text: "Rotate once." }],
      decisions: [{ id: "dec-1", text: "Runtime decision wording.", authority: { ...AUTHORITY } }],
    },
    integrationTarget: { summary: "Runtime adapter follow-up." },
    managers: {
      delivery: { threadId: INCUMBENT, epoch: 3 },
      retro: { threadId: role === "retro" ? INCUMBENT : "thread-retro", epoch: 1 },
    },
    status: "active",
    tasks: [
      {
        id: "task-a",
        projectId,
        title: "Owned task",
        specHash: "hash-a",
        dependencyHashes: [],
        dependencies: [],
        acceptanceIds: ["ac-1"],
        updatedAt: "2026-10-14T02:00:00.000Z",
      },
    ],
    updatedAt: "2026-10-14T02:00:00.000Z",
  });

const safeBoundary = (): RotationSafeBoundary => ({
  incumbentIntegrationRunning: false,
  incumbentGuiOwned: false,
  unresolvedShellWrite: false,
  sharedWriteUnknown: false,
  quiescenceUnknown: false,
  childWorkersPending: false,
  completionRoutingReady: true,
});

const layerExternalServices = (world: World) =>
  Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    Layer.succeed(ProjectService.ProjectService, {
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id: projectId,
                title: "Project",
                workspaceRoot: "/tmp/project",
                repositoryIdentity: null,
                faviconPath: null,
                defaultModelSelection: modelSelection,
                defaultThreadEnvMode: null,
                scripts: [],
                createdAt: "2026-06-20T00:00:00.000Z",
                updatedAt: "2026-06-20T00:00:00.000Z",
                deletedAt: null,
              })
            : Option.none(),
        ),
      getByWorkspaceRoot: () => Effect.succeed(Option.none()),
      snapshot: Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      listShells: () => Effect.die("unused"),
    }),
    // Any git call here would be a worktree side effect; unimplemented methods die.
    Layer.mock(GitWorkflow.GitWorkflowService)({}),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: () =>
        Effect.sync(() => {
          world.setupRuns += 1;
          return { status: "no-script" as const };
        }),
    }),
    Layer.mock(TextGeneration.TextGeneration)({}),
    ServerSettings.layerTest(),
    ProviderRegistryMock.layer(),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      folderForThread: () =>
        Effect.sync(() => {
          world.folderClaims += 1;
          return Option.none();
        }),
    }),
  );

const fakeHttpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43124),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("env-1")),
  getDescriptor: Effect.die("unused"),
});
const layerMcpRegistry = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing.make(),
).pipe(
  Layer.provide(Layer.succeed(HttpServer.HttpServer, fakeHttpServer)),
  Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment)),
  Layer.provide(NodeServices.layer),
);

interface HarnessOptions {
  readonly boundaryPort?: boolean;
}

const harness = (world: World, role: Role, artifactDirectory: string, options: HarnessOptions) => {
  const layerDatabase = Sqlite.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "manager-runtime-adapter" },
    ProviderAdapterRegistry.layerFromAdapters([makeProviderAdapter(world)]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerThreadManagement = ThreadManagement.layer.pipe(Layer.provide(layerOrchestrator));
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerExternalServices(world),
        layerThreadManagement,
        layerReceipts,
        IdAllocator.layer,
      ),
    ),
  );
  const lifecycleAuthority = Layer.succeed(Lifecycle.MissionManagerLifecycleAuthority, {
    teamId: "team-1",
    environmentId: "env-1",
    role,
    isCurrent: () => world.authorityOk,
  });
  // The adapter sees the live session manager except where a test makes one
  // session's detach fail, the way a wedged provider would.
  const layerSessions = Layer.effect(
    ProviderSessionManager.ProviderSessionManagerV2,
    Effect.gen(function* () {
      const real = yield* ProviderSessionManager.ProviderSessionManagerV2;
      return ProviderSessionManager.ProviderSessionManagerV2.of({
        ...real,
        detach: (input) =>
          world.failStopFor.has(String(input.providerSessionId))
            ? Effect.fail(
                new ProviderSessionManager.ProviderSessionReleaseError({
                  providerSessionId: input.providerSessionId,
                  reason: "manual_shutdown",
                }),
              )
            : real.detach(input),
        release: (input) =>
          world.failStopFor.has(String(input.providerSessionId))
            ? Effect.fail(
                new ProviderSessionManager.ProviderSessionReleaseError({
                  providerSessionId: input.providerSessionId,
                  reason: input.reason,
                }),
              )
            : real.release(input),
      });
    }),
  ).pipe(Layer.provide(layerOrchestrator));
  const layerBoundary =
    options.boundaryPort === false
      ? Layer.empty
      : Layer.succeed(RuntimeAdapter.MissionManagerBoundaryFacts, {
          quiesceBoundary: () => Effect.succeed(world.boundary),
          completionRoutingReady: () => Effect.succeed(world.routingReady),
        });
  const layerAdapter = RuntimeAdapter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        lifecycleAuthority,
        layerLaunch,
        layerThreadManagement,
        layerSessions,
        layerMcpRegistry,
        layerReceipts,
        layerBoundary,
        layerDatabase,
      ),
    ),
  );
  const layerLifecycle = Lifecycle.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        lifecycleAuthority,
        RuntimeAdapter.layerFactsPort.pipe(Layer.provide(layerAdapter)),
        PersistedEvents.layer,
        PersistedReceipts.layer,
        layerDatabase,
      ),
    ),
  );
  const layerTransfer = TransferStore.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(TransferStore.MissionManagerReservationAuthority, {
          teamId: "team-1",
          environmentId: "env-1",
          controllerThreadId: INCUMBENT,
          role,
          isCurrent: () => true,
        }),
        Layer.succeed(TransferStore.MissionManagerTrustedFactsPort, {
          readFacts: () =>
            world.reserveFacts === null
              ? Effect.fail(
                  new TransferStore.MissionManagerTransferStoreError({
                    operation: "reserve",
                    category: "scope_denied",
                  }),
                )
              : Effect.succeed(world.reserveFacts),
          isCurrent: (facts: RFacts) => facts.fence === "fence-1",
        }),
        Artifacts.layerFilesystemManagerHandoffArtifactPort(artifactDirectory),
        PersistedEvents.layer,
        PersistedReceipts.layer,
        layerDatabase,
      ),
    ),
  );
  const layerMissions = MissionService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        PersistedEvents.layer,
        PersistedReceipts.layer,
        Layer.succeed(MissionService.MissionAuthority, {
          teamId: TeamId.make("team-1"),
          environmentId: EnvironmentId.make("env-1"),
          controllerThreadId: INCUMBENT,
        }),
        layerDatabase,
      ),
    ),
  );
  return Layer.mergeAll(
    layerAdapter,
    layerLifecycle,
    layerTransfer,
    layerMissions,
    layerOrchestrator,
    layerThreadManagement,
    layerLaunch,
    layerMcpRegistry,
    IdAllocator.layer,
    PersistedEvents.layer,
    PersistedReceipts.layer,
  ).pipe(Layer.provideMerge(layerDatabase), Layer.provide(NodeServices.layer));
};

// -------------------------------------------------------------------- helpers

const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const privateTempRoot = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix });
    yield* Effect.promise(() => NodeFSP.chmod(dir, 0o700));
    return dir;
  });

const currentMission = Effect.gen(function* () {
  const service = yield* MissionService.MissionService;
  return Option.getOrThrow(yield* service.get(MissionId.make(MISSION_ID)));
});

const assignmentOf = (mission: Mission, role: Role) =>
  role === "delivery" ? mission.managers.delivery : mission.managers.retro;

const reservationOf = (reservationId: string) =>
  Effect.map(currentMission, (mission) => {
    const found = (mission.execution?.managerReservations ?? []).find(
      (entry) => entry.reservationId === reservationId,
    );
    return found ?? assert.fail("reservation missing");
  });

const projectionOf = (threadId: ThreadId) =>
  Effect.flatMap(ThreadManagement.ThreadManagementService, (threads) =>
    threads.getThreadProjection(threadId),
  );

const threadCount = Effect.flatMap(ThreadManagement.ThreadManagementService, (threads) =>
  Effect.map(
    threads.listProjectThreads({ projectId, includeSubagents: true }),
    (shells) => shells.length,
  ),
);

/** A bare thread record, standing in for a manager or worker that already exists. */
const bareThread = (thread: ThreadId) =>
  Effect.flatMap(ThreadLaunch.ThreadLaunchService, (launches) =>
    launches.launch({
      commandId: CommandId.make(`command:bare:${thread}`),
      threadId: thread,
      projectId,
      title: `Thread ${thread}`,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      createdBy: "user",
      creationSource: "web",
      standby: true,
    }),
  );

const mcpTokens = new Map<string, string>();

/** A provider session for `thread`, plus the MCP credential its process was started with. */
const startSession = (thread: ThreadId, sessionId: string, options: { mcp?: boolean } = {}) =>
  Effect.gen(function* () {
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    yield* sessions.open({
      threadId: thread,
      providerSessionId: ProviderSessionId.make(sessionId),
      modelSelection,
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: process.cwd() },
    });
    if (options.mcp === false) return;
    // The session manager here runs without MCP, so attach the credential the
    // way a configured one would: issued by the registry, held in the config slot.
    const issued = yield* registry.issue({
      threadId: thread,
      providerInstanceId: modelSelection.instanceId,
    });
    McpProviderSession.setMcpProviderSession(issued.config);
    mcpTokens.set(String(thread), issued.config.authorizationHeader.replace(/^Bearer\s+/, ""));
  });

/** The provider thread a real turn leaves behind, which names the session that served it. */
const recordProviderThread = (thread: ThreadId, sessionId: string) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const now = yield* DateTime.now;
    const nativeId = `native:${thread}`;
    const providerThread: OrchestrationV2ProviderThread = {
      id: ids.derive.providerThread({ driver: CODEX, nativeThreadId: nativeId }),
      driver: CODEX,
      providerInstanceId: modelSelection.instanceId,
      providerSessionId: ProviderSessionId.make(sessionId),
      appThreadId: thread,
      ownerNodeId: null,
      nativeThreadRef: { driver: CODEX, nativeId, strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };
    yield* sink.write({
      events: [
        {
          id: yield* ids.allocate.event({ threadId: thread }),
          type: "provider-thread.updated" as const,
          threadId: thread,
          driver: CODEX,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: providerThread,
        },
      ],
    });
  });

const credentialAlive = (thread: ThreadId) =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const token = mcpTokens.get(String(thread));
    if (token === undefined) return assert.fail(`no credential was issued for ${thread}`);
    const scope = yield* registry.resolve(token);
    return (
      scope !== undefined &&
      McpProviderSession.readMcpProviderSession(thread) !== undefined &&
      scope.thread.threadId === thread
    );
  });

const sessionLive = (sessionId: string) =>
  Effect.flatMap(ProviderSessionManager.ProviderSessionManagerV2, (sessions) =>
    Effect.map(sessions.get(ProviderSessionId.make(sessionId)), Option.isSome),
  );

const encodeMissionJson = Schema.encodeSync(Schema.fromJsonString(Mission));
const isRuntimeError = Schema.is(RuntimeAdapter.MissionManagerRuntimeError);
/** Rewrites the canonical snapshot directly, as an outside writer or a prior switch would. */
const overwriteMission = (mission: Mission) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql`UPDATE projection_missions SET revision = ${mission.revision}, snapshot_json = ${encodeMissionJson(mission)} WHERE mission_id = ${MISSION_ID}`,
  );

const seedAndReserve = (world: World, role: Role, dir: string) =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    yield* service.execute({
      type: "mission.create",
      commandId: CommandId.make("seed-runtime"),
      mission: missionFixture(role),
    });
    const canonical = yield* currentMission;
    const decision = evaluateManagerRotation({
      mission: canonical,
      role,
      projectTimezone: TIMEZONE,
      nowIso: NOW_ISO,
      lastSlot: null,
      contextPressure: undefined,
      safeBoundary: safeBoundary(),
      retroQueueDepth: role === "retro" ? 1 : undefined,
      userStopRequested: false,
      userPauseRequested: false,
    });
    assert.strictEqual(decision.kind, "rotate");
    if (decision.kind !== "rotate") throw new Error("expected rotate");
    const intent = decision.intent;
    const staged = yield* Artifacts.stageManagerHandoffArtifact({
      artifactDirectory: dir,
      input: {
        mission: canonical,
        intent,
        ownership: [
          { taskId: "task-a", threadId: INCUMBENT, runId: INCUMBENT_RUN, attemptNumber: 1 },
        ],
        predecessor: {
          missionId: canonical.id,
          teamId: "team-1",
          environmentId: "env-1",
          role,
          managerThreadId: EARLIER_THREAD,
          epoch: role === "delivery" ? 2 : 0,
        },
      },
    });
    world.reserveFacts = {
      teamId: "team-1",
      environmentId: "env-1",
      missionId: canonical.id,
      role,
      currentThreadId: intent.currentThreadId,
      currentEpoch: intent.currentEpoch,
      observedRevision: canonical.revision,
      projectTimezone: TIMEZONE,
      nowIso: NOW_ISO,
      lastSlot: null,
      contextPressure: undefined,
      safeBoundary: safeBoundary(),
      retroQueueDepth: role === "retro" ? 1 : undefined,
      userStopRequested: false,
      userPauseRequested: false,
      fence: "fence-1",
    };
    const store = yield* TransferStore.MissionManagerTransferStore;
    const reserved = yield* store.reserve({
      commandId: CommandId.make("reserve-runtime"),
      missionId: canonical.id,
      role,
      expectedRevision: intent.observedRevision,
      projectTimezone: TIMEZONE,
      currentThreadId: intent.currentThreadId,
      currentEpoch: intent.currentEpoch,
      localDate: intent.localDate,
      ordinal: intent.ordinal,
      reason: intent.reason,
      artifactRef: staged.artifactRef,
    });
    assert.isTrue(Result.isSuccess(reserved));
    return Result.getOrThrow(reserved).reservation;
  });

interface Rig {
  readonly world: World;
  readonly role: Role;
  readonly reservationId: string;
  readonly successor: ThreadId;
  readonly incumbentSession: string;
  readonly workerSession: string;
  readonly adapter: RuntimeAdapter.MissionManagerRuntimeAdapter["Service"];
  readonly lifecycle: Lifecycle.MissionManagerLifecycleStore["Service"];
  seq: number;
}

const request = (rig: Rig) => ({
  missionId: MISSION_ID,
  role: rig.role,
  reservationId: rig.reservationId,
});

/** A full lifecycle attempt through the genuine store; the facts come from the adapter. */
const attempt = (rig: Rig, step: Step, options: { readonly commandId?: string } = {}) =>
  Effect.gen(function* () {
    rig.seq += 1;
    const mission = yield* currentMission;
    return yield* rig.lifecycle.advance({
      commandId: CommandId.make(options.commandId ?? `${step}-${rig.seq}`),
      missionId: mission.id,
      role: rig.role,
      reservationId: rig.reservationId,
      step,
      expectedRevision: mission.revision,
    });
  });

const committed = (result: Lifecycle.ManagerLifecycleResult) => {
  assert.isTrue(Result.isSuccess(result), "the step committed");
  return Result.getOrThrow(result);
};
const holdCode = (result: Lifecycle.ManagerLifecycleResult): string => {
  if (Result.isSuccess(result)) return assert.fail("expected a hold, but the step committed");
  return result.failure.code;
};

const adapterHold = (outcome: { readonly kind: string; readonly code?: string }) => {
  assert.strictEqual(outcome.kind, "hold");
  return outcome.code;
};

interface RigOptions extends HarnessOptions {
  readonly shared?: boolean;
  /** Opens the incumbent's provider session and MCP credential. Default true. */
  readonly incumbentSession?: boolean;
}

const withRig = <A, E, R>(
  role: Role,
  options: RigOptions,
  body: (rig: Rig) => Effect.Effect<A, E, R>,
) =>
  scoped(
    Effect.gen(function* () {
      const world = makeWorld(options.shared ?? false);
      const dir = yield* privateTempRoot(`manager-runtime-${role}-`);
      const inner = Effect.gen(function* () {
        // The MCP config slot is process-global; start every scenario from empty.
        mcpTokens.clear();
        for (const thread of [INCUMBENT, WORKER, BYSTANDER]) {
          McpProviderSession.clearMcpProviderSession(thread);
        }
        yield* Effect.forEach([INCUMBENT, WORKER, BYSTANDER], bareThread, { discard: true });
        const incumbentSession = "provider-session:incumbent";
        const workerSession =
          options.shared === true ? incumbentSession : "provider-session:worker";
        if (options.incumbentSession !== false) {
          yield* startSession(INCUMBENT, incumbentSession);
          yield* recordProviderThread(INCUMBENT, incumbentSession);
        }
        yield* startSession(WORKER, workerSession);
        yield* recordProviderThread(WORKER, workerSession);
        yield* startSession(BYSTANDER, "provider-session:bystander");
        yield* recordProviderThread(BYSTANDER, "provider-session:bystander");
        const reservation = yield* seedAndReserve(world, role, dir);
        return yield* body({
          world,
          role,
          reservationId: reservation.reservationId,
          successor: ThreadId.make(reservation.successorThreadId),
          incumbentSession,
          workerSession,
          adapter: yield* RuntimeAdapter.MissionManagerRuntimeAdapter,
          lifecycle: yield* Lifecycle.MissionManagerLifecycleStore,
          seq: 0,
        });
      });
      return yield* inner.pipe(Effect.provide(harness(world, role, dir, options)));
    }),
  );

const send = (to: ThreadId, text: string, id: string) =>
  Effect.flatMap(ThreadManagement.ThreadManagementService, (threads) =>
    threads.sendToThread({
      projectId,
      commandId: CommandId.make(`command:send:${id}`),
      threadId: to,
      messageId: MessageId.make(`message:send:${id}`),
      text,
      attachments: [],
      mode: "queue",
      createdBy: "user",
      creationSource: "web",
    }),
  );

/** Stands in for the successor model's reply, which is the one thing the adapter must never write. */
const modelReplies = (thread: ThreadId, text: string, id: string) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: yield* ids.allocate.event({ threadId: thread }),
          type: "message.updated" as const,
          threadId: thread,
          occurredAt: now,
          payload: {
            createdBy: "agent" as const,
            creationSource: "provider" as const,
            id: MessageId.make(`message:reply:${id}`),
            threadId: thread,
            runId: null,
            nodeId: null,
            role: "assistant" as const,
            text,
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
  });

const delegatedChild = (
  parent: ThreadId,
  origin: "app_owned" | "provider_native",
  childThreadId: ThreadId | null,
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const now = yield* DateTime.now;
    const subagent: OrchestrationV2Subagent = {
      id: NodeId.make(`node:child:${origin}:${parent}`),
      threadId: parent,
      runId: null,
      parentNodeId: NodeId.make(`node:parent:${parent}`),
      origin,
      createdBy: "agent",
      driver: CODEX,
      providerInstanceId: modelSelection.instanceId,
      providerThreadId: null,
      childThreadId,
      nativeTaskRef: null,
      prompt: "Do the delegated work.",
      title: "Delegated worker",
      model: null,
      status: "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    yield* sink.write({
      events: [
        {
          id: yield* ids.allocate.event({ threadId: parent }),
          type: "subagent.updated" as const,
          threadId: parent,
          occurredAt: now,
          payload: subagent,
        },
      ],
    });
  });

/** Drives the real lifecycle store up to and including `target`, with the adapter supplying facts. */
const advanceThrough = (rig: Rig, target: Step) =>
  Effect.gen(function* () {
    const order: ReadonlyArray<Step> = ["standby", "quiesce", "transfer", "routing", "retire"];
    for (const step of order) {
      if (step === "standby") committed(yield* attemptWithLaunch(rig));
      else if (step === "routing") yield* confirmRoutingAsSuccessor(rig);
      else if (step === "retire") {
        const cleaned = yield* rig.adapter.cleanupIncumbent(request(rig));
        assert.strictEqual(cleaned.kind, "released");
        committed(yield* attempt(rig, step, { commandId: `${step}-main` }));
      } else committed(yield* attempt(rig, step, { commandId: `${step}-main` }));
      if (step === target) return;
    }
  });

const attemptWithLaunch = (rig: Rig) =>
  Effect.gen(function* () {
    const launched = yield* rig.adapter.launchStandby(request(rig));
    assert.strictEqual(launched.kind, "standby");
    return yield* attempt(rig, "standby", { commandId: "standby-main" });
  });

/** The activation wake, then the new owner's own acknowledgement, then the routing step. */
const confirmRoutingAsSuccessor = (rig: Rig) =>
  Effect.gen(function* () {
    const woke = yield* rig.adapter.wakeCurrentRole({
      ...request(rig),
      wakeKey: "activation",
      instruction: "You now own this role.",
      reservationId: rig.reservationId,
    });
    assert.strictEqual(woke.kind, "sent");
    const reservation = yield* reservationOf(rig.reservationId);
    const mission = yield* currentMission;
    yield* modelReplies(
      rig.successor,
      RuntimeAdapter.managerAckLine({
        reservationId: rig.reservationId,
        role: rig.role,
        epoch: reservation.lifecycle?.transfer?.newEpoch ?? -1,
        revision: mission.revision,
      }),
      "ack-main",
    );
    committed(yield* attempt(rig, "routing", { commandId: "routing-main" }));
  });

// ---------------------------------------------------------------------- tests

it.effect("creates the reserved successor under its canonical id and starts nothing", () =>
  withRig("delivery", {}, (rig) =>
    Effect.gen(function* () {
      const before = yield* threadCount;
      const launched = yield* rig.adapter.launchStandby(request(rig));
      assert.strictEqual(launched.kind, "standby");
      if (launched.kind !== "standby") return;
      // The identity is the one the reserve store minted, not a new allocation.
      assert.strictEqual(launched.threadId, rig.successor);
      assert.isFalse(launched.resumed);
      assert.strictEqual(launched.commandId, `manager-standby:${rig.reservationId}`);
      assert.strictEqual(yield* threadCount, before + 1);

      const projection = yield* projectionOf(rig.successor);
      const incumbent = (yield* projectionOf(INCUMBENT)).thread;
      assert.strictEqual(projection.thread.projectId, incumbent.projectId);
      assert.strictEqual(projection.thread.runtimeMode, incumbent.runtimeMode);
      assert.strictEqual(projection.thread.modelSelection.model, incumbent.modelSelection.model);
      for (const records of [
        projection.runs,
        projection.messages,
        projection.providerSessions,
        projection.subagents,
      ]) {
        assert.lengthOf(records, 0);
      }
      // No workspace preparation or provider process: only the three bare threads and
      // the sessions this test opened itself exist.
      assert.strictEqual(rig.world.setupRuns, 0);
      assert.strictEqual(rig.world.folderClaims, 0);
      assert.deepStrictEqual(rig.world.opened.sort(), [
        "provider-session:bystander",
        "provider-session:incumbent",
        "provider-session:worker",
      ]);

      // The role has not moved: standby is not ownership.
      const mission = yield* currentMission;
      assert.deepStrictEqual(assignmentOf(mission, "delivery"), { threadId: INCUMBENT, epoch: 3 });
      assert.strictEqual(
        managerReservationState(yield* reservationOf(rig.reservationId)),
        "reserved",
      );

      // A lost reply replays to the same thread, with no second record or event.
      const sequence = yield* Effect.flatMap(ThreadManagement.ThreadManagementService, (threads) =>
        threads.getThreadEventSequence(rig.successor),
      );
      const again = yield* rig.adapter.launchStandby(request(rig));
      assert.strictEqual(again.kind, "standby");
      if (again.kind === "standby") {
        assert.isTrue(again.resumed);
        assert.strictEqual(again.threadId, rig.successor);
      }
      assert.strictEqual(yield* threadCount, before + 1);
      assert.strictEqual(
        yield* Effect.flatMap(ThreadManagement.ThreadManagementService, (threads) =>
          threads.getThreadEventSequence(rig.successor),
        ),
        sequence,
      );
    }),
  ),
);

it.effect("holds a standby launch that is not safe or not needed, and creates nothing", () =>
  withRig("delivery", {}, (rig) =>
    Effect.gen(function* () {
      const before = yield* threadCount;
      const mission = yield* currentMission;

      // A moved owner kills the reservation: the incumbent no longer owns the role.
      yield* overwriteMission({
        ...mission,
        managers: { ...mission.managers, delivery: { threadId: WORKER, epoch: 3 } },
      });
      assert.strictEqual(
        adapterHold(yield* rig.adapter.launchStandby(request(rig))),
        "owner_changed",
      );

      // A paused mission is not rotated.
      yield* overwriteMission({ ...mission, status: "paused" });
      assert.strictEqual(
        adapterHold(yield* rig.adapter.launchStandby(request(rig))),
        "mission_inactive",
      );

      // A reservation that is not ours (wrong id, wrong role) is denied outright.
      yield* overwriteMission(mission);
      const unknown = yield* rig.adapter
        .launchStandby({ ...request(rig), reservationId: "mgr-does-not-exist" })
        .pipe(Effect.flip);
      assert.strictEqual(unknown.category, "scope_denied");
      const wrongRole = yield* rig.adapter
        .launchStandby({ ...request(rig), role: "retro" })
        .pipe(Effect.flip);
      assert.strictEqual(wrongRole.category, "scope_denied");

      assert.strictEqual(yield* threadCount, before);
      assert.strictEqual(rig.world.setupRuns, 0);
    }),
  ),
);

it.effect("holds a standby launch once the owner switch has happened", () =>
  withRig("delivery", {}, (rig) =>
    Effect.gen(function* () {
      yield* advanceThrough(rig, "transfer");
      assert.strictEqual(
        adapterHold(yield* rig.adapter.launchStandby(request(rig))),
        "not_launchable",
      );
    }),
  ),
);

it.effect("reports standby readiness only for the launched, still-inert successor", () =>
  withRig("delivery", {}, (rig) =>
    Effect.gen(function* () {
      // Before any launch there is no receipt and no thread: unknown, so a hold.
      assert.strictEqual(holdCode(yield* attempt(rig, "standby")), "facts_unknown");

      yield* rig.adapter.launchStandby(request(rig));
      const reservation = yield* reservationOf(rig.reservationId);
      const facts = yield* rig.adapter.readLifecycleFacts({ ...request(rig), step: "standby" });
      assert.deepStrictEqual(
        {
          reservationId: facts.standby?.reservationId,
          successorThreadId: facts.standby?.successorThreadId,
          handoffSha256: facts.standby?.handoffSha256,
          epoch: facts.standby?.epoch,
          observedRevision: facts.standby?.observedRevision,
          dispatchEnabled: facts.standby?.dispatchEnabled,
          guiLeaseHeld: facts.standby?.guiLeaseHeld,
        },
        {
          reservationId: rig.reservationId,
          successorThreadId: rig.successor,
          handoffSha256: reservation.artifactSha256,
          epoch: reservation.currentEpoch,
          observedRevision: reservation.observedRevision,
          dispatchEnabled: false,
          guiLeaseHeld: false,
        },
      );
      // Metadata only: the ack binds the creation receipt without carrying thread content.
      assert.match(facts.standby?.ackDigest ?? "", /^[0-9a-f]{64}$/);

      // A successor that has already been given work is denied, not merely held.
      yield* send(rig.successor, "Start working before the switch.", "premature");
      const worked = yield* rig.adapter.readLifecycleFacts({ ...request(rig), step: "standby" });
      assert.isTrue(worked.standby?.dispatchEnabled, "a successor with a run can dispatch");
      assert.isTrue(worked.standby?.guiLeaseHeld, "and could hold a GUI lease");
      const denied = yield* attempt(rig, "standby").pipe(Effect.flip);
      assert.strictEqual(denied.category, "scope_denied");
      assert.strictEqual(
        managerReservationState(yield* reservationOf(rig.reservationId)),
        "reserved",
      );
    }),
  ),
);

it.effect(
  "a revision that drifted after the caller read conflicts, writes nothing, and succeeds on reread",
  () =>
    withRig("delivery", {}, (rig) =>
      Effect.gen(function* () {
        yield* rig.adapter.launchStandby(request(rig));
        const mission = yield* currentMission;
        // A competing writer lands a revision after the caller read the mission.
        yield* overwriteMission({ ...mission, revision: mission.revision + 1 });
        const stale = yield* rig.lifecycle
          .advance({
            commandId: CommandId.make("standby-stale"),
            missionId: MISSION_ID,
            role: "delivery",
            reservationId: rig.reservationId,
            step: "standby",
            expectedRevision: mission.revision,
          })
          .pipe(Effect.flip);
        assert.strictEqual(stale.category, "request_conflict");
        assert.strictEqual(
          managerReservationState(yield* reservationOf(rig.reservationId)),
          "reserved",
        );
        assert.strictEqual((yield* currentMission).revision, mission.revision + 1);

        // Rereading binds the facts and the step to the new revision.
        const fresh = committed(yield* attempt(rig, "standby", { commandId: "standby-fresh" }));
        assert.strictEqual(fresh.reservation.lifecycle?.state, "standby_ready");
      }),
    ),
);

it.effect("keeps quiesce a hold until the boundary is known and quiet", () =>
  withRig("delivery", {}, (rig) =>
    Effect.gen(function* () {
      committed(yield* attemptWithLaunch(rig));

      // Integration, GUI and writes have no runtime source: a producer that does not
      // know reports unknown, and the step holds.
      rig.world.boundary = null;
      assert.strictEqual(holdCode(yield* attempt(rig, "quiesce")), "facts_unknown");

      // Observed live background work is a writer the external port cannot clear.
      rig.world.boundary = quietBoundary();
      rig.world.background.add(rig.incumbentSession);
      const writing = yield* rig.adapter.readLifecycleFacts({ ...request(rig), step: "quiesce" });
      assert.strictEqual(writing.quiesce?.unmanagedShellWrites, "present");
      assert.isNull(writing.quiesce?.fence, "no fence is invented");
      assert.strictEqual(holdCode(yield* attempt(rig, "quiesce")), "unsafe_boundary");
      rig.world.background.clear();

      // Every external answer that is not a clean "none" holds.
      for (const [patch, code] of [
        [{ integrationRunning: true }, "unsafe_boundary"],
        [{ guiOwned: true }, "unsafe_boundary"],
        [{ integrationRunning: null }, "facts_unknown"],
        [{ guiOwned: null }, "facts_unknown"],
        [{ unmanagedShellWrites: "present" as const }, "unsafe_boundary"],
        [{ sharedWrites: "present" as const }, "unsafe_boundary"],
        [{ unmanagedShellWrites: "unknown" as const }, "facts_unknown"],
        [{ sharedWrites: "unknown" as const }, "facts_unknown"],
      ] as const) {
        rig.world.boundary = { ...quietBoundary(), ...patch };
        assert.strictEqual(holdCode(yield* attempt(rig, "quiesce")), code);
      }

      // An incumbent that is mid-turn is not quiet, whatever the boundary says.
      rig.world.boundary = quietBoundary();
      yield* send(INCUMBENT, "Keep going.", "incumbent-busy");
      assert.strictEqual(holdCode(yield* attempt(rig, "quiesce")), "unsafe_boundary");
    }),
  ),
);

it.effect(
  "accepts unknown writes only behind a confirmed process fence, passed through unchanged",
  () =>
    withRig("delivery", {}, (rig) =>
      Effect.gen(function* () {
        committed(yield* attemptWithLaunch(rig));
        const fence = { kind: "confirmed_process_fence" as const, digest: sha("fence") };
        rig.world.boundary = { ...quietBoundary(), unmanagedShellWrites: "unknown", fence };
        const facts = yield* rig.adapter.readLifecycleFacts({ ...request(rig), step: "quiesce" });
        assert.deepStrictEqual(facts.quiesce?.fence, fence);
        committed(yield* attempt(rig, "quiesce"));
      }),
    ),
);

it.effect("without the boundary port the quiesce and transfer steps stay unknown", () =>
  withRig("delivery", { boundaryPort: false }, (rig) =>
    Effect.gen(function* () {
      committed(yield* attemptWithLaunch(rig));
      assert.strictEqual(holdCode(yield* attempt(rig, "quiesce")), "facts_unknown");
      assert.isNull(
        (yield* rig.adapter.readLifecycleFacts({ ...request(rig), step: "quiesce" })).quiesce,
      );
    }),
  ),
);

it.effect("holds the transfer when completion routing readiness is false or unknown", () =>
  withRig("delivery", {}, (rig) =>
    Effect.gen(function* () {
      committed(yield* attemptWithLaunch(rig));
      committed(yield* attempt(rig, "quiesce", { commandId: "quiesce-main" }));
      rig.world.routingReady = null;
      assert.strictEqual(holdCode(yield* attempt(rig, "transfer")), "facts_unknown");
      rig.world.routingReady = false;
      assert.strictEqual(holdCode(yield* attempt(rig, "transfer")), "routing_not_ready");
      const mission = yield* currentMission;
      assert.deepStrictEqual(assignmentOf(mission, "delivery"), { threadId: INCUMBENT, epoch: 3 });
    }),
  ),
);

it.effect.each(["delivery", "retro"] as const)(
  "rotates the %s role end to end and retires only the incumbent",
  (role) =>
    withRig(role, {}, (rig) =>
      Effect.gen(function* () {
        const incumbentSession = rig.incumbentSession;
        const otherRole = role === "delivery" ? "retro" : "delivery";
        const before = yield* currentMission;
        const otherBefore = assignmentOf(before, otherRole);

        committed(yield* attemptWithLaunch(rig));
        committed(yield* attempt(rig, "quiesce", { commandId: "quiesce-main" }));
        const transferred = committed(
          yield* attempt(rig, "transfer", { commandId: "transfer-main" }),
        );
        assert.deepStrictEqual(transferred.manager, {
          threadId: rig.successor,
          epoch: (assignmentOf(before, role)?.epoch ?? -1) + 1,
        });

        // Wake the new owner; the old one hears nothing.
        const woke = yield* rig.adapter.wakeCurrentRole({
          ...request(rig),
          wakeKey: "activation",
          instruction: "You now own this role.",
          reservationId: rig.reservationId,
        });
        assert.strictEqual(woke.kind, "sent");
        if (woke.kind !== "sent") return;
        assert.strictEqual(woke.threadId, rig.successor);
        const successorMessages = (yield* projectionOf(rig.successor)).messages;
        assert.lengthOf(successorMessages, 1);
        const wakeText = successorMessages[0]?.text ?? "";
        assert.include(wakeText, `epoch=${woke.epoch}`);
        assert.include(wakeText, RuntimeAdapter.MANAGER_ACK_PREFIX);
        assert.lengthOf((yield* projectionOf(INCUMBENT)).messages, 0);

        // The adapter cannot confirm routing for the model: no reply, no confirmation.
        assert.strictEqual(holdCode(yield* attempt(rig, "routing")), "facts_unknown");
        const mission = yield* currentMission;
        const newEpoch =
          (yield* reservationOf(rig.reservationId)).lifecycle?.transfer?.newEpoch ?? -1;
        const ack = (override: Partial<Parameters<typeof RuntimeAdapter.managerAckLine>[0]>) =>
          RuntimeAdapter.managerAckLine({
            reservationId: rig.reservationId,
            role,
            epoch: newEpoch,
            revision: mission.revision,
            ...override,
          });
        // Replies for another epoch, another reservation, or a stale revision confirm nothing.
        yield* modelReplies(rig.successor, ack({ epoch: newEpoch - 1 }), "ack-old-epoch");
        yield* modelReplies(rig.successor, ack({ reservationId: "mgr-other" }), "ack-other");
        assert.strictEqual(holdCode(yield* attempt(rig, "routing")), "facts_unknown");
        yield* modelReplies(rig.successor, ack({ revision: mission.revision - 1 }), "ack-stale");
        assert.strictEqual(holdCode(yield* attempt(rig, "routing")), "routing_not_ready");
        yield* modelReplies(rig.successor, `Ready.\n${ack({})}\n`, "ack-good");
        committed(yield* attempt(rig, "routing", { commandId: "routing-main" }));

        // Cleanup stops the incumbent's session and credential, and only those.
        assert.isTrue(yield* sessionLive(incumbentSession));
        assert.isTrue(yield* credentialAlive(INCUMBENT));
        const cleaned = yield* rig.adapter.cleanupIncumbent(request(rig));
        assert.deepStrictEqual(cleaned, { kind: "released", sessionIds: [incumbentSession] });
        assert.isFalse(yield* sessionLive(incumbentSession));
        assert.isFalse(yield* credentialAlive(INCUMBENT));
        assert.isTrue(yield* sessionLive(rig.workerSession));
        assert.isTrue(yield* credentialAlive(WORKER));
        assert.isTrue(yield* sessionLive("provider-session:bystander"));
        assert.isTrue(yield* credentialAlive(BYSTANDER));
        assert.deepStrictEqual(rig.world.closed, [incumbentSession]);

        committed(yield* attempt(rig, "retire", { commandId: "retire-main" }));
        const after = yield* currentMission;
        assert.deepStrictEqual(assignmentOf(after, role)?.threadId, rig.successor);
        assert.deepStrictEqual(assignmentOf(after, otherRole), otherBefore);
        assert.strictEqual(
          managerReservationState(yield* reservationOf(rig.reservationId)),
          "retired",
        );
        // The incumbent's thread record and transcript are kept; only its runtime went,
        // and the projection says so durably.
        const retired = yield* projectionOf(INCUMBENT);
        assert.isNull(retired.thread.archivedAt);
        assert.deepStrictEqual(
          retired.providerSessions.map((session) => session.status),
          ["stopped"],
        );
        // Session handles and credentials never reach the mission snapshot.
        const stored = encodeMissionJson(after);
        for (const secret of [incumbentSession, mcpTokens.get(String(INCUMBENT)) ?? "x"]) {
          assert.notInclude(stored, secret);
        }
      }),
    ),
);

const wakeOf = (rig: Rig, key: string, extra: Partial<RuntimeAdapter.WakeRequest> = {}) =>
  rig.adapter.wakeCurrentRole({
    ...request(rig),
    wakeKey: key,
    instruction: "Result ready.",
    ...extra,
  });
const messageCount = (thread: ThreadId) =>
  Effect.map(projectionOf(thread), (projection) => projection.messages.length);

it.effect("wakes the incumbent, not the standby, until the switch", () =>
  withRig("delivery", {}, (rig) =>
    Effect.gen(function* () {
      yield* rig.adapter.launchStandby(request(rig));
      const first = yield* wakeOf(rig, "one");
      assert.strictEqual(first.kind, "sent");
      if (first.kind === "sent") {
        assert.strictEqual(first.threadId, INCUMBENT);
        assert.strictEqual(first.epoch, 3);
      }
      assert.strictEqual(yield* messageCount(INCUMBENT), 1);
      assert.strictEqual(yield* messageCount(rig.successor), 0);
      // The same key at the same epoch is one delivery.
      yield* wakeOf(rig, "one");
      assert.strictEqual(yield* messageCount(INCUMBENT), 1);

      // A caller holding a different owner or epoch gets a hold, not a delivery.
      for (const expectedOwner of [
        { threadId: rig.successor, epoch: 4 },
        { threadId: rig.successor, epoch: 3 },
        { threadId: INCUMBENT, epoch: 2 },
      ]) {
        assert.strictEqual(
          adapterHold(yield* wakeOf(rig, "two", { expectedOwner })),
          "owner_changed",
        );
      }
      assert.strictEqual(yield* messageCount(INCUMBENT), 1);
      assert.strictEqual(yield* messageCount(rig.successor), 0);
    }),
  ),
);

it.effect(
  "after the switch wakes only the new owner at its epoch, never the retired incumbent",
  () =>
    withRig("delivery", {}, (rig) =>
      Effect.gen(function* () {
        yield* advanceThrough(rig, "transfer");
        const woke = yield* wakeOf(rig, "three");
        assert.strictEqual(woke.kind, "sent");
        if (woke.kind === "sent") {
          assert.strictEqual(woke.threadId, rig.successor);
          assert.strictEqual(woke.epoch, 4);
        }
        assert.strictEqual(yield* messageCount(rig.successor), 1);
        assert.strictEqual(yield* messageCount(INCUMBENT), 0);

        // A caller still holding the incumbent at its old epoch is told to reread.
        const late = yield* wakeOf(rig, "four", {
          expectedOwner: { threadId: INCUMBENT, epoch: 3 },
        });
        assert.strictEqual(adapterHold(late), "owner_changed");
        assert.strictEqual(yield* messageCount(INCUMBENT), 0);

        // A key used before the switch is a new delivery at the new epoch, to the new owner only.
        yield* wakeOf(rig, "one");
        assert.strictEqual(yield* messageCount(rig.successor), 2);
        assert.strictEqual(yield* messageCount(INCUMBENT), 0);

        // An archived owner or an inactive mission is not woken.
        const mission = yield* currentMission;
        yield* overwriteMission({ ...mission, status: "paused" });
        assert.strictEqual(adapterHold(yield* wakeOf(rig, "five")), "mission_inactive");
        assert.strictEqual(yield* messageCount(rig.successor), 2);
      }),
    ),
);

it.effect(
  "cleanup preserves a delegated worker, an unrelated thread and the host's other credentials",
  () =>
    withRig("delivery", {}, (rig) =>
      Effect.gen(function* () {
        // The incumbent delegated to WORKER, which has its own session and credential.
        yield* delegatedChild(INCUMBENT, "app_owned", WORKER);
        committed(yield* attemptWithLaunch(rig));
        committed(yield* attempt(rig, "quiesce", { commandId: "quiesce-main" }));
        committed(yield* attempt(rig, "transfer", { commandId: "transfer-main" }));
        yield* confirmRoutingAsSuccessor(rig);

        const facts = yield* rig.adapter.readLifecycleFacts({ ...request(rig), step: "retire" });
        assert.strictEqual(facts.cleanup?.childDependencies, "none");
        assert.isFalse(facts.cleanup?.providerSession.released);
        assert.isFalse(facts.cleanup?.mcp.released);
        assert.deepStrictEqual(facts.cleanup?.ownedResources, {
          expectedIds: [`provider-session:${rig.incumbentSession}`, `mcp-credentials:${INCUMBENT}`],
          releasedIds: [],
        });
        // Not released yet: retirement holds.
        assert.strictEqual(holdCode(yield* attempt(rig, "retire")), "cleanup_incomplete");

        const cleaned = yield* rig.adapter.cleanupIncumbent(request(rig));
        assert.strictEqual(cleaned.kind, "released");

        assert.isFalse(yield* sessionLive(rig.incumbentSession));
        assert.isFalse(yield* credentialAlive(INCUMBENT));
        // The worker keeps running with its own session and credential; so does everything else.
        assert.isTrue(yield* sessionLive(rig.workerSession));
        assert.isTrue(yield* credentialAlive(WORKER));
        assert.isTrue(yield* sessionLive("provider-session:bystander"));
        assert.isTrue(yield* credentialAlive(BYSTANDER));
        assert.deepStrictEqual(rig.world.closed, [rig.incumbentSession]);
        const worker = yield* projectionOf(WORKER);
        assert.deepStrictEqual(
          worker.providerSessions.map((session) => session.id),
          [rig.workerSession],
        );
        assert.isNull(worker.thread.archivedAt);

        // The receipt now reports everything released, and the store commits the retirement.
        const after = yield* rig.adapter.readLifecycleFacts({ ...request(rig), step: "retire" });
        assert.isTrue(after.cleanup?.providerSession.released);
        assert.isTrue(after.cleanup?.mcp.released);
        assert.deepStrictEqual(
          after.cleanup?.ownedResources.releasedIds.slice().sort(),
          after.cleanup?.ownedResources.expectedIds.slice().sort(),
        );
        committed(yield* attempt(rig, "retire", { commandId: "retire-main" }));

        // Retrying a finished cleanup is a no-op that still reports released.
        const replay = yield* rig.adapter.cleanupIncumbent(request(rig));
        assert.strictEqual(replay.kind, "released");
        assert.isTrue(yield* sessionLive(rig.workerSession));
      }),
    ),
);

it.effect("detaches only the incumbent from a session it shares with a worker", () =>
  withRig("delivery", { shared: true }, (rig) =>
    Effect.gen(function* () {
      // One provider process serves both threads.
      assert.strictEqual(rig.incumbentSession, rig.workerSession);
      yield* advanceThrough(rig, "routing");
      const cleaned = yield* rig.adapter.cleanupIncumbent(request(rig));
      assert.deepStrictEqual(cleaned, { kind: "released", sessionIds: [rig.incumbentSession] });
      // The shared process stays up for the worker; the incumbent is detached from it.
      assert.isTrue(yield* sessionLive(rig.workerSession));
      assert.deepStrictEqual(rig.world.closed, []);
      assert.isFalse(yield* credentialAlive(INCUMBENT));
      assert.isTrue(yield* credentialAlive(WORKER));
      assert.lengthOf((yield* projectionOf(INCUMBENT)).providerSessions, 0);
      assert.deepStrictEqual(
        (yield* projectionOf(WORKER)).providerSessions.map((session) => session.id),
        [rig.workerSession],
      );
      committed(yield* attempt(rig, "retire", { commandId: "retire-main" }));
    }),
  ),
);

it.effect("holds cleanup that is not yet safe and touches nothing", () =>
  withRig("delivery", {}, (rig) =>
    Effect.gen(function* () {
      const untouched = Effect.gen(function* () {
        assert.isTrue(yield* sessionLive(rig.incumbentSession));
        assert.isTrue(yield* credentialAlive(INCUMBENT));
        assert.isTrue(yield* sessionLive(rig.workerSession));
        assert.isTrue(yield* credentialAlive(WORKER));
        assert.deepStrictEqual(rig.world.closed, []);
      });

      // Before the switch the incumbent owns the role and must never be cleaned.
      assert.strictEqual(
        adapterHold(yield* rig.adapter.cleanupIncumbent(request(rig))),
        "not_retirable",
      );
      yield* untouched;
      yield* advanceThrough(rig, "transfer");
      assert.strictEqual(
        adapterHold(yield* rig.adapter.cleanupIncumbent(request(rig))),
        "not_retirable",
      );
      yield* untouched;
    }),
  ),
);

it.effect("holds retirement while a provider-native subagent lives in the session", () =>
  withRig("delivery", {}, (rig) =>
    Effect.gen(function* () {
      yield* delegatedChild(INCUMBENT, "provider_native", null);
      yield* advanceThrough(rig, "routing");
      const facts = yield* rig.adapter.readLifecycleFacts({ ...request(rig), step: "retire" });
      assert.strictEqual(facts.cleanup?.childDependencies, "blocking");
      assert.strictEqual(
        adapterHold(yield* rig.adapter.cleanupIncumbent(request(rig))),
        "child_dependencies",
      );
      assert.strictEqual(holdCode(yield* attempt(rig, "retire")), "child_dependencies");
      // Nothing was stopped on the way.
      assert.isTrue(yield* sessionLive(rig.incumbentSession));
      assert.isTrue(yield* credentialAlive(INCUMBENT));
      assert.deepStrictEqual(rig.world.closed, []);
    }),
  ),
);

it.effect("holds cleanup for an incumbent that woke and started a turn after the switch", () =>
  withRig("delivery", {}, (rig) =>
    Effect.gen(function* () {
      yield* advanceThrough(rig, "routing");
      yield* send(INCUMBENT, "Late work from the retired manager.", "late");
      assert.strictEqual(
        adapterHold(yield* rig.adapter.cleanupIncumbent(request(rig))),
        "incumbent_active",
      );
      assert.isTrue(yield* sessionLive(rig.incumbentSession));
      assert.isTrue(yield* credentialAlive(INCUMBENT));
    }),
  ),
);

it.effect("treats an incumbent with no recorded provider session as unknown, never released", () =>
  withRig("delivery", { incumbentSession: false }, (rig) =>
    Effect.gen(function* () {
      yield* advanceThrough(rig, "routing");
      const facts = yield* rig.adapter.readLifecycleFacts({ ...request(rig), step: "retire" });
      assert.isNull(facts.cleanup);
      // Nothing to reconcile a release against: the action refuses rather than guess.
      assert.strictEqual(
        adapterHold(yield* rig.adapter.cleanupIncumbent(request(rig))),
        "cleanup_incomplete",
      );
      assert.strictEqual(holdCode(yield* attempt(rig, "retire")), "facts_unknown");
    }),
  ),
);

it.effect("reports a stop failure as a failure and holds retirement until it is retried", () =>
  withRig("delivery", {}, (rig) =>
    Effect.gen(function* () {
      yield* advanceThrough(rig, "routing");
      rig.world.failStopFor.add(rig.incumbentSession);
      const failure = yield* rig.adapter.cleanupIncumbent(request(rig)).pipe(Effect.flip);
      assert.strictEqual(failure.category, "persistence");
      // The credential is revoked only after the stop succeeded, so a failed stop leaves
      // the incumbent fully intact for the retry.
      assert.isTrue(yield* sessionLive(rig.incumbentSession));
      assert.isTrue(yield* credentialAlive(INCUMBENT));
      assert.strictEqual(holdCode(yield* attempt(rig, "retire")), "cleanup_incomplete");

      rig.world.failStopFor.clear();
      const retried = yield* rig.adapter.cleanupIncumbent(request(rig));
      assert.strictEqual(retried.kind, "released");
      committed(yield* attempt(rig, "retire", { commandId: "retire-main" }));
    }),
  ),
);

it.effect("denies every action once the authority is revoked and stales earlier facts", () =>
  withRig("delivery", {}, (rig) =>
    Effect.gen(function* () {
      const before = yield* rig.adapter.readLifecycleFacts({ ...request(rig), step: "standby" });
      assert.strictEqual(before.fence, rig.adapter.currentFence());
      // Any action that can change what the producer would report ends the fence.
      yield* rig.adapter.launchStandby(request(rig));
      assert.notStrictEqual(before.fence, rig.adapter.currentFence());

      rig.world.authorityOk = false;
      const denied = [
        yield* rig.adapter.launchStandby(request(rig)).pipe(Effect.flip),
        yield* rig.adapter.cleanupIncumbent(request(rig)).pipe(Effect.flip),
        yield* rig.adapter
          .wakeCurrentRole({ ...request(rig), wakeKey: "k", instruction: "x" })
          .pipe(Effect.flip),
        yield* rig.adapter
          .readLifecycleFacts({ ...request(rig), step: "standby" })
          .pipe(Effect.flip),
      ];
      for (const error of denied) {
        assert.isTrue(isRuntimeError(error));
        assert.strictEqual(error.category, "scope_denied");
      }
      // The other role is not this adapter's to touch.
      rig.world.authorityOk = true;
      const otherRole = yield* rig.adapter
        .wakeCurrentRole({ missionId: MISSION_ID, role: "retro", wakeKey: "k", instruction: "x" })
        .pipe(Effect.flip);
      assert.strictEqual(otherRole.category, "scope_denied");
    }),
  ),
);
