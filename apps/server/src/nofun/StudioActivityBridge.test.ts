// StudioActivityBridge.test.ts — runtimeLayer-level wiring test.
//
// Builds the real orchestration layers (memory sqlite) plus the bridge with
// a fake fetch, dispatches thread.create through the orchestrator, and
// asserts the bridge POSTs the shell-only envelope. No new scheduler is
// involved: delivery rides the existing application-event stream.

import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { beforeEach, expect, vi } from "vite-plus/test";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Mock the required execFile boundary so tests never read real Keychain credentials.
import * as NodeChildProcess from "node:child_process";
import {
  CommandId,
  type ModelSelection,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { StudioActivityPublisher, type StudioActivityState } from "./StudioActivityPublisher.ts";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as StudioActivityBridge from "./StudioActivityBridge.ts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: vi.fn(),
}));

const execFile = vi.mocked(NodeChildProcess.execFile);
const unsafeKeychainError = "keychain-test-secret in stderr and error";
const mockKeychainResult = (error: Error | null, stdout: string) => {
  execFile.mockImplementation((...args) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(error, stdout, unsafeKeychainError);
    return {} as NodeChildProcess.ChildProcess;
  });
};

beforeEach(() => {
  execFile.mockReset();
  mockKeychainResult(new Error(unsafeKeychainError), "");
});

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-studio-activity-bridge-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);
const layerGitWorkflowTest = Layer.mock(GitWorkflow.GitWorkflowService)({
  pruneWorktrees: () => Effect.void,
  createWorktree: () => Effect.succeed({} as never),
});
const layerProjectServiceTest = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.succeed(Option.none()),
});

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by bridge tests"),
} as ProviderAdapterV2Shape;
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerTestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const decodePostedBody = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      partition_id: Schema.String,
      records: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

interface PostedCall {
  readonly url: string;
  readonly authorization: string | null;
  readonly bodyText: string;
}

// Match server.ts: the bridge explicitly receives the same layer references
// used by the orchestration runtime; merging siblings does not provide them.
const layerBridgeTest = (
  options: StudioActivityBridge.StudioActivityBridgeOptions,
  platform: NodeJS.Platform = "darwin",
) =>
  Layer.mergeAll(
    RuntimeLayer.layer,
    RuntimeLayer.layerEventSink,
    RuntimeLayer.layerEventInfrastructure,
    ProjectStore.layer,
    ProjectionStore.layer,
    EffectOutbox.layer,
    ThreadCommandExecutor.layer,
    StudioActivityBridge.layerWithBridgeOptions({
      publishOnStart: false,
      minIntervalMs: 0,
      stateStore: { load: async () => null, save: async () => {} },
      ...options,
    }).pipe(
      Layer.provide(ProjectionStore.layer),
      Layer.provide(ProjectStore.layer),
      Layer.provide(RuntimeLayer.layerEventInfrastructure),
      Layer.provide(SqlitePersistence.layerMemory),
    ),
  ).pipe(
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(layerCheckpointStoreTest),
    Layer.provide(layerServerConfig),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerTestProviderInstanceRegistry),
    Layer.provide(layerGitWorkflowTest),
    Layer.provide(layerProjectServiceTest),
    Layer.provide(
      Layer.mock(WorkspacePaths.WorkspacePaths)({
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
        peek: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
        request: () => Effect.void,
        getAvailable: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
        invalidate: () => Effect.void,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(layerPlatformTest),
    Layer.provide(Layer.succeed(HostProcessPlatform, platform)),
  );

const createThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projectId = ProjectId.make("studio-bridge-project");
  const createdAt = "2026-10-12T00:00:00.000Z";
  yield* projects.apply({
    sequence: 0,
    eventId: EventId.make("seed:studio-bridge-project"),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: createdAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Bridge project",
      workspaceRoot: "/work/bridge",
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  });
  yield* orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("studio-bridge-create"),
    threadId: ThreadId.make("studio-bridge-thread"),
    projectId,
    title: "Bridge thread",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
});

it.effect.each([
  { name: "No Fun", env: {}, included: true },
  { name: "default URL", env: { NOFUN_STUDIO_BRIDGE_URL: undefined }, included: true },
  {
    name: "outside persona roots",
    env: { T3CODE_PERSONA: "nofun", T3CODE_PERSONA_ROOTS: "/allowed" },
    included: false,
  },
])("configured server bridge posts one shell snapshot on thread.create ($name)", (scenario) =>
  Effect.gen(function* () {
    const posted = Promise.withResolvers<PostedCall>();
    const calls: PostedCall[] = [];
    const layer = layerBridgeTest({
      env: {
        NOFUN_STUDIO_BRIDGE_URL: "http://bridge.test",
        NOFUN_STUDIO_BRIDGE_TOKEN: "test-token",
        ...scenario.env,
      },
      fetchFn: async (url, init) => {
        if (init.method === "GET")
          return Response.json({ events: [], cursor: null, has_more: false, watermark: null });
        const call = {
          url,
          authorization: new Headers(init.headers).get("Authorization"),
          bodyText: String(init.body),
        };
        calls.push(call);
        posted.resolve(call);
        return Response.json({
          verdict: "accept",
          eventId: "evt_test",
          ...(() => {
            const input = JSON.parse(String(init.body));
            return { stamp: input.stamp, payloadHash: input.payloadHash };
          })(),
        });
      },
    });
    yield* Effect.gen(function* () {
      yield* createThread;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const snapshot = yield* projections.getShellSnapshot();
      // A thread absent from current project settings cannot become standard.
      const unknown = StudioActivityBridge.toActivityReads({
        threads: snapshot.threads,
        projects: [],
        team: "nofun",
        isPrivateRoot: () => false,
      });
      assert.isTrue(unknown.every((thread) => thread.projectKind === "unknown"));
      yield* Effect.promise(() => posted.promise);
    }).pipe(Effect.provide(layer));
    // The layer has closed: no publisher fibers can emit a later duplicate.
    assert.lengthOf(calls, 1);
    const call = calls[0]!;
    assert.equal(
      call.url,
      scenario.name === "default URL"
        ? "https://grok-bot-mcp-bridge.vercel.app/api/studio/producers"
        : "http://bridge.test/api/studio/producers",
    );
    assert.equal(execFile.mock.calls.length, 0);
    assert.equal(call.authorization, "Bearer test-token");
    const body = yield* decodePostedBody(call.bodyText);
    expect(body.partition_id).toBe("t3.activity");
    expect(body.records).toEqual(
      scenario.included
        ? [
            {
              projection_id: "t3.activity:studio-bridge-thread:no-run",
              origin_id: "studio-bridge-project",
              kind: "local_task",
              record_id: "studio-bridge-thread",
              revision_scheme: "t3.run-revision",
              revision_value: expect.any(String),
              canonical_state: "idle",
              summary: "Bridge thread",
              observed_at: expect.any(String),
              fresh_until: expect.any(String),
              correlation: null,
              provenance: "known",
              restriction: "none",
              derived: false,
            },
          ]
        : [],
    );
    assert.notInclude(call.bodyText, "test-token");
  }),
);

it.effect("pending HTTP delivery does not block commands and coalesces activity", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const nextPost = Promise.withResolvers<PostedCall>();
    const calls: PostedCall[] = [];
    let active = 0;
    let maxActive = 0;
    const layer = layerBridgeTest({
      env: {
        NOFUN_STUDIO_BRIDGE_URL: "http://bridge.test",
        NOFUN_STUDIO_BRIDGE_TOKEN: "test-token",
      },
      fetchFn: async (url, init) => {
        if (init.method === "GET")
          return Response.json({ events: [], cursor: null, has_more: false, watermark: null });
        const call = {
          url,
          authorization: new Headers(init.headers).get("Authorization"),
          bodyText: String(init.body),
        };
        calls.push(call);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (calls.length === 1) {
            started.resolve();
            await release.promise;
          } else {
            nextPost.resolve(call);
          }
          return Response.json({
            verdict: "accept",
            eventId: "evt_test",
            ...(() => {
              const input = JSON.parse(String(init.body));
              return { stamp: input.stamp, payloadHash: input.payloadHash };
            })(),
          });
        } finally {
          active -= 1;
        }
      },
    });
    const latest = yield* Effect.gen(function* () {
      yield* createThread;
      yield* Effect.promise(() => started.promise);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      // These commits must finish while the first network request is held.
      for (const title of ["Updated once", "Updated twice", "Latest shell title"]) {
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`bridge-update:${title}`),
          threadId: ThreadId.make("studio-bridge-thread"),
          title,
        });
      }
      assert.lengthOf(calls, 1);
      release.resolve();
      return yield* Effect.promise(() => nextPost.promise);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => release.resolve())));
    assert.equal(maxActive, 1);
    const body = yield* decodePostedBody(latest.bodyText);
    assert.equal(body.records[0]?.summary, "Latest shell title");
  }),
);

it.effect.each([
  { name: "empty env", env: {} },
  { name: "URL only", env: { NOFUN_STUDIO_BRIDGE_URL: "http://bridge.test" } },
  { name: "explicit empty token", env: { NOFUN_STUDIO_BRIDGE_TOKEN: "" } },
  {
    name: "CATCHES persona, no token",
    env: { T3CODE_PERSONA: "catches" },
  },
  {
    name: "CATCHES persona, fully configured",
    env: {
      T3CODE_PERSONA: "catches",
      NOFUN_STUDIO_BRIDGE_URL: "http://bridge.test",
      NOFUN_STUDIO_BRIDGE_TOKEN: "test-token",
    },
  },
])("unconfigured server bridge sends nothing ($name)", ({ env }) =>
  Effect.gen(function* () {
    let calls = 0;
    yield* createThread.pipe(
      Effect.provide(
        layerBridgeTest({
          env,
          fetchFn: async () => {
            calls += 1;
            return new Response("{}");
          },
        }),
      ),
    );
    assert.equal(calls, 0);
    if (env.T3CODE_PERSONA === "catches" || env.NOFUN_STUDIO_BRIDGE_TOKEN !== undefined) {
      assert.equal(execFile.mock.calls.length, 0);
    }
  }),
);

it.effect("missing env token uses the trimmed macOS Keychain token with the default URL", () =>
  Effect.gen(function* () {
    mockKeychainResult(null, "  keychain-test-token\n");
    const posted = Promise.withResolvers<PostedCall>();
    yield* Effect.gen(function* () {
      yield* createThread;
      const call = yield* Effect.promise(() => posted.promise);
      assert.equal(call.url, "https://grok-bot-mcp-bridge.vercel.app/api/studio/producers");
      assert.equal(call.authorization, "Bearer keychain-test-token");
      assert.notInclude(call.bodyText, "keychain-test-token");
    }).pipe(
      Effect.provide(
        layerBridgeTest({
          env: { USER: "bridge-user; shell syntax is literal" },
          fetchFn: async (url, init) => {
            if (init.method === "GET")
              return Response.json({ events: [], cursor: null, has_more: false, watermark: null });
            posted.resolve({
              url,
              authorization: new Headers(init.headers).get("Authorization"),
              bodyText: String(init.body),
            });
            return Response.json({
              verdict: "accept",
              eventId: "evt_test",
              ...(() => {
                const input = JSON.parse(String(init.body));
                return { stamp: input.stamp, payloadHash: input.payloadHash };
              })(),
            });
          },
        }),
      ),
    );
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-a",
        "bridge-user; shell syntax is literal",
        "-s",
        "nofun-studio-bridge",
        "-w",
      ],
      { encoding: "utf8", timeout: 2_000 },
      expect.any(Function),
    );
  }),
);

it.effect.each([
  { name: "lookup error", error: new Error(unsafeKeychainError), stdout: "keychain-test-secret" },
  { name: "empty item", error: null, stdout: "  \n" },
])("Keychain failure disables publishing with a value-free message ($name)", ({ error, stdout }) =>
  Effect.gen(function* () {
    mockKeychainResult(error, stdout);
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });
    let calls = 0;
    yield* createThread.pipe(
      Effect.provide(
        layerBridgeTest({
          env: { USER: "bridge-user" },
          fetchFn: async () => {
            calls += 1;
            return new Response("{}");
          },
        }).pipe(Layer.provide(Logger.layer([logger], { mergeWithExisting: false }))),
      ),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
    );
    assert.equal(calls, 0);
    assert.isTrue(
      messages.some((message) => message.includes("keychain item nofun-studio-bridge unavailable")),
    );
    assert.notInclude(messages.join("\n"), "keychain-test-secret");
    assert.notInclude(messages.join("\n"), "stderr");
    assert.equal(execFile.mock.calls.length, 1);
  }),
);

it.effect("non-macOS startup never reads the Keychain", () =>
  Effect.gen(function* () {
    let calls = 0;
    yield* createThread.pipe(
      Effect.provide(
        layerBridgeTest(
          {
            env: {},
            fetchFn: async () => {
              calls += 1;
              return new Response("{}");
            },
          },
          "linux",
        ),
      ),
    );
    assert.equal(calls, 0);
    assert.equal(execFile.mock.calls.length, 0);
  }),
);

it.effect(
  "startup readback and idle retry recover a lost POST without another application event",
  () =>
    Effect.gen(function* () {
      let saved: StudioActivityState | null = null;
      let clock = 1000;
      let posts = 0;
      let reads = 0;
      const firstAttempt = Promise.withResolvers<void>();
      const savedAck = Promise.withResolvers<void>();
      const failed = Promise.withResolvers<void>();
      const layer = layerBridgeTest({
        env: {
          NOFUN_STUDIO_BRIDGE_URL: "http://bridge.test",
          NOFUN_STUDIO_BRIDGE_TOKEN: "fixture",
        },
        publishOnStart: true,
        minIntervalMs: 0,
        idleIntervalMs: 1000,
        retryTickMs: 100,
        nowMs: () => clock,
        stateStore: {
          load: async () => structuredClone(saved),
          save: async (state) => {
            saved = structuredClone(state);
            if (state.watermark) savedAck.resolve();
            if (state.failures > 0) failed.resolve();
          },
        },
        fetchFn: async (_url, init) => {
          if (init.method === "GET") {
            reads++;
            return Response.json({ events: [], cursor: null, has_more: false, watermark: null });
          }
          posts++;
          if (posts === 1) {
            firstAttempt.resolve();
            return new Response("busy", { status: 503 });
          }
          const input = JSON.parse(String(init.body));
          return Response.json({
            verdict: "replay_duplicate",
            eventId: "evt_retried",
            stamp: input.stamp,
            payloadHash: input.payloadHash,
          });
        },
      });
      yield* Effect.gen(function* () {
        yield* Effect.promise(() => firstAttempt.promise);
        yield* Effect.promise(() => failed.promise);
        clock = 3000;
        yield* TestClock.adjust(1100);
        yield* Effect.promise(() => savedAck.promise);
        assert.equal(posts, 2);
        assert.isAtLeast(reads, 2);
        assert.lengthOf(saved!.pending, 0);
        assert.equal(saved!.watermark?.eventId, "evt_retried");
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("startup retries the persisted envelope before allocating a fresh snapshot", () =>
  Effect.gen(function* () {
    let state: StudioActivityState | null = null;
    const seed = new StudioActivityPublisher({
      epoch: StudioActivityBridge.STUDIO_ACTIVITY_BRIDGE_EPOCH,
      allowedProjectIds: [],
      reads: { listActivityThreads: () => [] },
      retryBaseMs: 0,
      stateStore: {
        load: async () => null,
        save: async (value) => {
          state = structuredClone(value);
        },
      },
      sink: {
        send: () => {
          throw new Error("offline");
        },
      },
    });
    const pending = yield* Effect.promise(() => seed.publishNow());
    const retried = Promise.withResolvers<string>();
    yield* Effect.gen(function* () {
      const bytes = yield* Effect.promise(() => retried.promise);
      assert.equal(bytes, JSON.stringify(pending.envelope));
    }).pipe(
      Effect.provide(
        layerBridgeTest({
          env: {
            NOFUN_STUDIO_BRIDGE_URL: "http://bridge.test",
            NOFUN_STUDIO_BRIDGE_TOKEN: "fixture",
          },
          publishOnStart: true,
          stateStore: {
            load: async () => structuredClone(state),
            save: async (value) => {
              state = structuredClone(value);
            },
          },
          fetchFn: async (_url, init) => {
            if (init.method === "GET")
              return Response.json({ events: [], cursor: null, has_more: false, watermark: null });
            retried.resolve(String(init.body));
            const input = JSON.parse(String(init.body));
            return Response.json({
              verdict: "accept",
              eventId: `evt_${input.stamp.sequence}`,
              stamp: input.stamp,
              payloadHash: input.payloadHash,
            });
          },
        }),
      ),
    );
  }),
);
