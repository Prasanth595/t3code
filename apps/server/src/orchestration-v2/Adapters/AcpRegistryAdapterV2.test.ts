import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type ModelSelection,
  type ProviderOptionSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as ServerSettings from "../../serverSettings.ts";
import type {
  AcpRegistryAvailableCommands,
  AcpRegistryLiveConfiguration,
} from "@t3tools/provider-acp-registry/testing";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import { ACP_SESSION_MODE_OPTION_ID } from "@t3tools/provider-acp/server/sessionConfig";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import {
  CLINE_SECONDARY_MODEL_SELECTION,
  clineConfigOptionsAnsweredAt,
} from "../testkit/fixtures/acp_secondary_model/input.ts";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2 } from "../builtInProviderAdapterDrivers.ts";
import { AcpRegistryAdapterV2Driver } from "@t3tools/provider-acp-registry/server";
import {
  ACP_REGISTRY_PROVIDER,
  acpRegistryProbeResult,
  applyAcpRegistryLiveConfiguration,
  buildCheckedAcpRegistrySnapshot,
  makeAcpRegistryAdapterV2,
  acpRegistryPromptFailure,
} from "@t3tools/provider-acp-registry/testing";

const registryUrl = "https://registry.test/registry.json";
const decodeAcpRegistryAdapterSettings = Schema.decodeUnknownEffect(
  AcpRegistryAdapterV2Driver.configSchema,
);
const decodeRegistrySettings = Schema.decodeSync(AcpRegistrySettings);

const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

const layerRegistry = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          version: "1.0.0",
          agents: [
            {
              id: "fixture-agent",
              name: "Fixture Agent",
              version: "1.0.0",
              description: "ACP V2 adapter fixture",
              distribution: {
                binary: {
                  "darwin-aarch64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                  "linux-x86_64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                },
              },
            },
          ],
        }),
      ),
    ),
  ),
);

// Adapters given an explicit runtime never resolve through the catalog.
const layerInjectedRuntimeCatalog = Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
  resolve: () => Effect.die("the runtime is injected"),
});

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
  layerRegistry,
  ServerSettings.layerTest(),
);

describe("AcpRegistryAdapterV2", () => {
  it("preserves and sanitizes structured ACP errors without exposing arbitrary defects", () => {
    const limit = new EffectAcpErrors.AcpRequestError({
      code: -31001,
      errorMessage: "Rate limit exceeded for mistral (model: mistral-vibe-cli-latest).",
    });
    assert.deepEqual(acpRegistryPromptFailure("mistral-vibe", limit), {
      class: "usage_limit",
      message: limit.errorMessage,
      code: "-31001",
      retryable: null,
    });
    assert.equal(acpRegistryPromptFailure("other-agent", limit).class, "provider_error");
    assert.equal(
      acpRegistryPromptFailure("mistral-vibe", new Error("private defect")).message,
      "Provider turn failed.",
    );
    const rejected = acpRegistryPromptFailure(
      "any-agent",
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Request rejected. api_key=private-key https://example.test/?token=secret",
      }),
    );
    assert.include(rejected.message, "Request rejected.");
    assert.notInclude(rejected.message, "private-key");
    assert.notInclude(rejected.message, "token=secret");
  });
  it("is registered as a generic provider driver with schema defaults", () => {
    assert.isTrue(BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2.has(ACP_REGISTRY_PROVIDER));
    assert.equal(AcpRegistryAdapterV2Driver.driverKind, ACP_REGISTRY_PROVIDER);
    assert.deepEqual(AcpRegistryAdapterV2Driver.defaultConfig(), {
      source: "registry",
      commandArgs: [],
      enabled: true,
      agentId: "",
      commandPath: "",
      authMethodId: "",
      distribution: "auto",
      customModels: [],
    });
  });

  describe("the agent's own mode picker", () => {
    type Frame = Record<string, unknown>;
    const outbound = (method: string, params: unknown = "<any>"): Frame => ({
      type: "expect_outbound",
      frame: { kind: "request", method, params },
    });
    const answer = (method: string, result: unknown): Frame => ({
      type: "emit_inbound",
      frame: { kind: "response", method, result },
    });
    const permissionModeOption = (currentValue: string) => ({
      id: "permission-mode",
      name: "Permission mode",
      category: "mode",
      type: "select",
      currentValue,
      options: ["ask", "auto"].map((value) => ({ value, name: value })),
    });

    // A scripted ACP v1 agent: initialize, session/new answered with `setup`,
    // then the frames T3 must send (and the agent's answers) to apply the
    // user's stored pick from the agent's mode picker.
    const openWithStoredModePick = Effect.fn("openWithStoredModePick")(function* (input: {
      readonly setup: unknown;
      readonly modeFrames: ReadonlyArray<Frame>;
      readonly storedModePick: string;
    }) {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const replayDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-mode-pick-",
      });
      const statusPath = path.join(replayDir, "status.json");
      const transcript = yield* decodeAcpReplayTranscript(
        {
          provider: ACP_REGISTRY_PROVIDER,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: "stored-mode-pick",
          entries: [
            outbound("initialize"),
            answer("initialize", {
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
              authMethods: [{ id: "test", name: "Test" }],
            }),
            outbound("session/new"),
            answer("session/new", { sessionId: "agent-session", ...(input.setup as object) }),
            ...input.modeFrames,
          ] as never,
        },
        ACP_REGISTRY_PROVIDER,
      );
      const instanceId = ProviderInstanceId.make("acp-registry-mode-pick");
      const adapter = yield* makeAcpRegistryAdapterV2({
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({
          agentId: "fixture-agent",
          authMethodId: "test",
        }),
        environment: {},
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
          ),
          childProcessSpawner,
          fileSystem,
        }),
      }).pipe(Effect.provide(layerInjectedRuntimeCatalog));
      yield* adapter
        .openSession({
          threadId: ThreadId.make("thread-acp-registry-mode-pick"),
          providerSessionId: ProviderSessionId.make("provider-session-mode-pick"),
          modelSelection: {
            instanceId,
            model: "default",
            options: [{ id: ACP_SESSION_MODE_OPTION_ID, value: input.storedModePick }],
          },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: replayDir,
          }),
        })
        .pipe(Effect.scoped);
      // Closing the session stops the agent, which writes its replay status in
      // the same tick as its last answer. The script must be consumed exactly.
      yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
    });

    it.effect("switches an agent that only advertises modes with session/set_mode", () =>
      openWithStoredModePick({
        setup: {
          modes: {
            currentModeId: "default",
            availableModes: ["default", "autoEdit"].map((id) => ({ id, name: id })),
          },
        },
        modeFrames: [
          outbound("session/set_mode", { sessionId: "agent-session", modeId: "autoEdit" }),
          answer("session/set_mode", {}),
        ],
        storedModePick: "autoEdit",
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect("switches a mode config option under its own id", () =>
      openWithStoredModePick({
        setup: { configOptions: [permissionModeOption("ask")] },
        modeFrames: [
          outbound("session/set_config_option", {
            sessionId: "agent-session",
            configId: "permission-mode",
            value: "auto",
          }),
          answer("session/set_config_option", { configOptions: [permissionModeOption("auto")] }),
        ],
        storedModePick: "auto",
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );
  });

  // Cline lists `provider` and then `model`, both `category: "model"`; the
  // model picker selects the provider and `model` is an ordinary option.
  describe("Cline's later model option", () => {
    const readClineTranscript = readProviderReplayTranscript(
      new URL(
        "../testkit/fixtures/acp_secondary_model/registry_transcript.ndjson",
        import.meta.url,
      ),
    );
    const passModels = [
      "cline-pass/mimo-v2.6-flash",
      "cline-pass/deepseek-v4.1-flash",
      "cline-pass/muse-spark-1.3-contributor",
    ];

    // Opens sessions on the source-shaped Cline replay. The agent stops after
    // the entry labelled `lastLabel` and rejects any request it does not expect.
    const makeClineSessions = Effect.fn("makeClineSessions")(function* (
      instanceId: ProviderInstanceId,
      lastLabel: string,
    ) {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const replayDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-cline-",
      });
      const recorded = yield* readClineTranscript;
      const last = recorded.entries.findIndex(
        (entry) => entry.type === "emit_inbound" && entry.label === lastLabel,
      );
      const transcript = yield* decodeAcpReplayTranscript(
        { ...recorded, entries: recorded.entries.slice(0, last + 1) },
        ACP_REGISTRY_PROVIDER,
      );
      const adapter = yield* makeAcpRegistryAdapterV2({
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({
          agentId: "fixture-agent",
          authMethodId: "replay",
        }),
        environment: {},
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          // Never read: the replay agent may still be writing it when stopped.
          statusPath: path.join(replayDir, "status.json"),
          scriptPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
          ),
          childProcessSpawner,
          fileSystem,
        }),
      }).pipe(Effect.provide(layerInjectedRuntimeCatalog));
      return (modelSelection: ModelSelection) =>
        adapter
          .openSession({
            threadId: ThreadId.make(`thread-${instanceId}`),
            providerSessionId: ProviderSessionId.make(`provider-session-${instanceId}`),
            modelSelection,
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "approval-required",
              interactionMode: "default",
              cwd: replayDir,
            }),
          })
          .pipe(Effect.scoped);
    });

    // The snapshot a server start publishes: one probe session on Cline's
    // default provider, `cline`, and no live observations.
    const discoverCline = Effect.fn("discoverCline")(function* (instanceId: ProviderInstanceId) {
      const recorded = yield* readClineTranscript;
      return buildCheckedAcpRegistrySnapshot({
        instanceId,
        displayName: "Cline",
        accentColor: undefined,
        continuationKey: `acpRegistry:instance:${instanceId}`,
        settings: decodeRegistrySettings({ agentId: "cline" }),
        checkedAt: "2026-10-15T00:00:00.000Z",
        inspection: {
          status: "ready",
          agentId: "cline",
          version: "3.0.70",
          distribution: "binary",
        },
        probe: {
          probe: acpRegistryProbeResult(instanceId, {
            sessionId: "cline-replay-session-1",
            initializeResult: { protocolVersion: 1 },
            sessionSetupResult: {
              sessionId: "cline-replay-session-1",
              configOptions: clineConfigOptionsAnsweredAt(recorded, "session.created"),
            },
            modelConfigId: "provider",
          }),
          slashCommands: [],
          skills: [],
        },
      });
    });

    const capabilitiesOf = (provider: ServerProvider, slug: string) =>
      provider.models.find((model) => model.slug === slug)?.capabilities;
    // The composer's options for a described model with stored picks applied,
    // as the web traits picker and mobile provider options resolve them.
    const descriptorsOn = (
      provider: ServerProvider,
      slug: string,
      stored: ReadonlyArray<ProviderOptionSelection> | undefined,
    ) =>
      getProviderOptionDescriptors({
        caps: capabilitiesOf(provider, slug) ?? {},
        selections: stored,
      });
    // What a send dispatches for a described model (web composer and mobile).
    const dispatched = (
      provider: ServerProvider,
      slug: string,
      stored: ReadonlyArray<ProviderOptionSelection> | undefined,
    ) =>
      buildExplicitProviderOptionSelectionsFromDescriptors(
        descriptorsOn(provider, slug, stored),
        stored,
      );
    // Toggling one trait stores every option's current value.
    const toggleAutoApprove = (provider: ServerProvider, slug: string) =>
      buildProviderOptionSelectionsFromDescriptors(
        descriptorsOn(provider, slug, undefined).map((descriptor) =>
          descriptor.id === "auto_approve" && descriptor.type === "boolean"
            ? { ...descriptor, currentValue: true }
            : descriptor,
        ),
      );
    const modelChoices = (provider: ServerProvider, slug: string) =>
      descriptorsOn(provider, slug, undefined).flatMap((descriptor) =>
        descriptor.id === "model" && descriptor.type === "select"
          ? descriptor.options.map((choice) => choice.id)
          : [],
      );
    const currentModel = (provider: ServerProvider, slug: string) =>
      descriptorsOn(provider, slug, undefined).find((descriptor) => descriptor.id === "model")
        ?.currentValue;

    // Cline's `model` setter accepts any id. A stored model from another
    // provider's catalog must fail the open rather than run Cline's default.
    it.effect("fails the open when the provider no longer offers the stored later model", () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("acp-registry-later-model");
        const open = yield* makeClineSessions(instanceId, "provider.applied");
        const staleModel = "cline-free/muse-spark-1.3-contributor";
        const error = yield* open({
          ...CLINE_SECONDARY_MODEL_SELECTION,
          instanceId,
          options: [{ id: "model", value: staleModel }],
        }).pipe(Effect.flip);

        // T3 rejected the stale model against ClinePass's catalog, the options
        // the agent answered the provider write with, so no model write was sent.
        assert.strictEqual(error._tag, "ProviderAdapterOpenSessionError");
        assert.instanceOf(error.cause, EffectAcpErrors.AcpRequestError);
        assert.deepEqual(error.cause.data, {
          configId: "model",
          allowedValues: passModels,
          receivedValue: staleModel,
        });
      }).pipe(
        Effect.provide(Layer.merge(layerTest, AcpRegistryRuntimeCoordinator.layer)),
        Effect.scoped,
      ),
    );

    // A server restart forgets every live observation, so only the probed
    // provider is described. Clients send a saved selection's own options
    // unchanged for a model whose options are unknown; the session must apply
    // the saved ClinePass model instead of ClinePass's default.
    it.effect("applies a saved ClinePass model after a restart forgot ClinePass's options", () =>
      Effect.gen(function* () {
        const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
        const instanceId = ProviderInstanceId.make("acp-registry-restart");
        const discovered = yield* discoverCline(instanceId);
        assert.strictEqual(capabilitiesOf(discovered, "cline-pass"), null);

        // The script expects the provider write, then exactly the saved model.
        const open = yield* makeClineSessions(instanceId, "model.applied");
        yield* open({ ...CLINE_SECONDARY_MODEL_SELECTION, instanceId });

        const live = applyAcpRegistryLiveConfiguration(
          discovered,
          Option.getOrThrow(yield* coordinator.getLiveConfiguration(instanceId)),
          [],
        );
        assert.deepEqual(modelChoices(live, "cline-pass"), passModels);
        assert.strictEqual(
          currentModel(live, "cline-pass"),
          CLINE_SECONDARY_MODEL_SELECTION.options[0].value,
        );
      }).pipe(
        Effect.provide(Layer.merge(layerTest, AcpRegistryRuntimeCoordinator.layer)),
        Effect.scoped,
      ),
    );

    // Cline's later `model` option and its default belong to the provider that
    // reported them. Options stored while on one provider, including that
    // provider's default model, must not constrain another provider's open.
    it.effect(
      "starts an unseen Cline provider on its own default model, then offers its catalog",
      () =>
        Effect.gen(function* () {
          const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
          const instanceId = ProviderInstanceId.make("acp-registry-provider-switch");
          const discovered = yield* discoverCline(instanceId);

          const storedOnCline = toggleAutoApprove(discovered, "cline");
          assert.deepEqual(storedOnCline, [
            { id: "model", value: "cline-free/step-5-preview" },
            { id: "mode", value: "act" },
            { id: "auto_approve", value: true },
          ]);
          // Nothing has described ClinePass yet: its options are unknown, not
          // Cline's. Clients send it only options saved for ClinePass itself.
          assert.strictEqual(capabilitiesOf(discovered, "cline-pass"), null);

          // The first ClinePass send writes only the provider and opens on the
          // agent's own ClinePass default. The script ends after the provider
          // write, so any later option write would be rejected.
          const open = yield* makeClineSessions(instanceId, "provider.applied");
          yield* open({ instanceId, model: "cline-pass" });

          // That session described ClinePass: its catalog and default now belong
          // to ClinePass, Cline keeps its own, and OpenAI stays undescribed.
          const live = applyAcpRegistryLiveConfiguration(
            discovered,
            Option.getOrThrow(yield* coordinator.getLiveConfiguration(instanceId)),
            [],
          );
          assert.deepEqual(modelChoices(live, "cline-pass"), passModels);
          assert.deepEqual(modelChoices(live, "cline"), [
            "cline-free/step-5-preview",
            "cline-free/mimo-v2.6-flash",
            "cline-free/muse-spark-1.3-contributor",
          ]);
          assert.strictEqual(capabilitiesOf(live, "openai-codex"), null);

          // Toggling Auto-approve on ClinePass stores ClinePass's own default.
          const storedOnPass = [
            { id: "model", value: "cline-pass/mimo-v2.6-flash" },
            { id: "mode", value: "act" },
            { id: "auto_approve", value: true },
          ];
          assert.deepEqual(toggleAutoApprove(live, "cline-pass"), storedOnPass);
          // Cline's stored picks resolve to ClinePass's values there, an explicit
          // ClinePass model is kept, and switching back keeps Cline's own picks.
          assert.deepEqual(dispatched(live, "cline-pass", storedOnCline), storedOnPass);
          assert.deepEqual(
            dispatched(live, "cline-pass", CLINE_SECONDARY_MODEL_SELECTION.options),
            [...CLINE_SECONDARY_MODEL_SELECTION.options],
          );
          assert.deepEqual(dispatched(live, "cline", storedOnCline), storedOnCline);
          assert.deepEqual(dispatched(live, "cline", storedOnPass), storedOnCline);
        }).pipe(
          Effect.provide(Layer.merge(layerTest, AcpRegistryRuntimeCoordinator.layer)),
          Effect.scoped,
        ),
    );
  });

  it.effect("offers client terminals to Devin only and client fs to no registry agent", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const advertisedCapabilities = Effect.fn("advertisedCapabilities")(function* (
        agentId: string,
      ) {
        let clientCapabilities: unknown;
        const instanceId = ProviderInstanceId.make(`acp-registry-capabilities-${agentId}`);
        const adapter = yield* makeAcpRegistryAdapterV2({
          selfInvocation: yield* resolveSelfInvocation(),
          instanceId,
          settings: yield* decodeAcpRegistryAdapterSettings({ agentId, authMethodId: "test" }),
          environment: {},
          makeRuntime: (input) =>
            Effect.gen(function* () {
              clientCapabilities = input.clientCapabilities;
              const { processEnvironment: _processEnvironment, ...runtimeInput } = input;
              const context = yield* Layer.build(
                AcpSessionRuntime.layer({
                  ...runtimeInput,
                  spawn: {
                    command: process.execPath,
                    args: [mockAgentPath],
                    cwd: input.cwd,
                    env: { T3_ACP_SESSION_LIFECYCLE: "1" },
                  },
                  authMethodId: "test",
                }).pipe(
                  Layer.provide(
                    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
                  ),
                ),
              );
              return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
                Effect.provide(context),
              );
            }),
        }).pipe(Effect.provide(layerInjectedRuntimeCatalog));
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        yield* adapter.openSession({
          threadId: ThreadId.make(`thread-acp-registry-capabilities-${agentId}`),
          providerSessionId: ProviderSessionId.make(`provider-session-capabilities-${agentId}`),
          modelSelection: { instanceId, model: "default" },
          runtimePolicy,
        });
        return clientCapabilities;
      });

      assert.deepInclude(yield* advertisedCapabilities("devin"), {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: true,
      });
      assert.deepInclude(yield* advertisedCapabilities("gemini"), {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("opens a real ACP child process resolved from registry configuration", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: host.paths.providerStatusCacheDir,
        toolsDir: host.paths.baseDir + "/tools",
        registryUrl,
      });
      const settings = yield* decodeAcpRegistryAdapterSettings({
        agentId: "fixture-agent",
        commandPath: process.execPath,
        authMethodId: "test",
      });
      let startupActive = false;
      let startupCount = 0;
      const instanceId = ProviderInstanceId.make("acp-registry-fixture");
      const commandsPublished = yield* Deferred.make<{
        readonly instanceId: ProviderInstanceId;
        readonly commands: AcpRegistryAvailableCommands;
      }>();
      const configurationPublished = yield* Deferred.make<AcpRegistryLiveConfiguration>();
      const adapter = yield* makeAcpRegistryAdapterV2({
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings,
        environment: {
          T3_ACP_SESSION_LIFECYCLE: "1",
          T3_ACP_COMMAND_ADVERTISEMENT_DELAY_MS: "750",
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({
              withForegroundStartup: (agentId, effect) =>
                Effect.acquireUseRelease(
                  Effect.sync(() => {
                    assert.equal(agentId, "fixture-agent");
                    startupActive = true;
                    startupCount += 1;
                  }),
                  () => effect,
                  () =>
                    Effect.sync(() => {
                      startupActive = false;
                    }),
                ),
              runBackgroundProbe: (_agentId, effect) => effect.pipe(Effect.map(Option.some)),
              withSessionMutation: (effect) => effect,
              clearAvailableCommands: () => Effect.void,
              publishAvailableCommands: (publishedInstanceId, commands) =>
                Deferred.succeed(commandsPublished, {
                  instanceId: publishedInstanceId,
                  commands,
                }).pipe(Effect.asVoid),
              getAvailableCommands: () => Effect.succeed(Option.none()),
              watchAvailableCommands: () => Effect.never,
              clearLiveConfiguration: () => Effect.void,
              publishLiveConfiguration: (_publishedInstanceId, configuration) =>
                Deferred.succeed(configurationPublished, configuration).pipe(Effect.asVoid),
              getLiveConfiguration: () => Effect.succeed(Option.none()),
              watchLiveConfiguration: () => Effect.never,
              requestUrlAuthentication: () => Effect.succeed(false),
              acceptUrlAuthentication: () => Effect.succeed(false),
              getUrlAuthAction: () => Effect.succeed(Option.none()),
              watchUrlAuthAction: () => Effect.never,
            }),
            Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
              resolve: (configuredSettings, cwd, environment) =>
                Effect.sync(() => assert.isTrue(startupActive)).pipe(
                  Effect.andThen(resolver.resolve(configuredSettings, cwd, environment)),
                  Effect.map((resolved) => ({
                    ...resolved,
                    spawn: {
                      ...resolved.spawn,
                      args: [mockAgentPath],
                    },
                  })),
                ),
            }),
          ),
        ),
      );
      const threadId = ThreadId.make("thread-acp-registry-fixture");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-registry-fixture"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });

      assert.equal(runtime.providerSession.driver, "acpRegistry");
      assert.equal(startupCount, 1);
      assert.isFalse(startupActive);
      assert.equal(providerThread.nativeThreadRef?.nativeId, "mock-session-1");
      assert.equal(providerThread.nativeMetadata?.itemIdentityVersion, 2);
      assert.isTrue(runtime.providerSession.capabilities.threads.canReadThreadSnapshot);
      assert.isTrue(runtime.providerSession.capabilities.threads.canForkThread);
      assert.deepEqual(yield* Deferred.await(commandsPublished), {
        instanceId,
        commands: {
          slashCommands: [
            {
              name: "review",
              description: "Review the current changes",
              input: { hint: "focus" },
            },
          ],
          skills: [
            {
              name: "workspace-skill",
              description: "Run the workspace skill",
              path: "acp://skill/workspace-skill",
              scope: "agent",
              enabled: true,
            },
          ],
        },
      });
      const configuration = yield* Deferred.await(configurationPublished);
      assert.equal(configuration.currentModelId, "default");
      assert.deepInclude(configuration.models[0], {
        id: "default",
        name: "Auto",
        description: null,
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
