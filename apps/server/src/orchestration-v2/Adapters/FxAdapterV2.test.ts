import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { ACP_PROTOCOL } from "@t3tools/provider-acp/server/adapter";
import {
  FX_ACP_CANCEL_BEHAVIOR,
  FX_DRIVER_KIND,
  FxProviderCapabilitiesV2,
  makeFxAdapterV2,
} from "@t3tools/provider-fx/testing";
import { FxSettings } from "@t3tools/provider-fx/settings";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";

const decodeFxSettings = Schema.decodeSync(FxSettings);
const recordedConfigOptions = [
  {
    id: "provider",
    name: "Provider",
    category: "model",
    type: "select",
    currentValue: "gateway",
    options: [{ value: "gateway", name: "Vercel AI Gateway" }],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "anthropic/claude-opus-5.5",
    options: [
      { value: "anthropic/claude-sonnet-5.5", name: "anthropic/claude-sonnet-5.5" },
      { value: "anthropic/claude-opus-5.5", name: "anthropic/claude-opus-5.5" },
    ],
  },
  {
    id: "mode",
    name: "Session Mode",
    category: "mode",
    type: "select",
    currentValue: "ask",
    options: [
      { value: "code", name: "Code" },
      { value: "ask", name: "Ask" },
    ],
  },
  {
    id: "effort",
    name: "Reasoning Effort",
    category: "thought_level",
    type: "select",
    currentValue: "xhigh",
    options: [
      { value: "medium", name: "medium" },
      { value: "high", name: "high" },
      { value: "xhigh", name: "xhigh" },
    ],
  },
] as const satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const testLayer = TestProviderHost.layer().pipe(
  Layer.provide(NodeServices.layer),
  Layer.merge(IdAllocator.layer),
  Layer.merge(McpProviderSessions.layer),
  Layer.merge(NodeServices.layer),
);

type ReplayEntry = {
  readonly type: "expect_outbound" | "emit_inbound";
  readonly frame: {
    readonly kind: "request" | "response";
    readonly method: string;
    readonly params?: unknown;
    readonly result?: unknown;
  };
};

const outbound = (method: string, params: unknown = "<any>"): ReplayEntry => ({
  type: "expect_outbound",
  frame: { kind: "request", method, ...(params === undefined ? {} : { params }) },
});
const answer = (method: string, result: unknown): ReplayEntry => ({
  type: "emit_inbound",
  frame: { kind: "response", method, result },
});

function withCurrent(
  configId: string,
  value: string,
  base: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = recordedConfigOptions,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return base.map((option) =>
    option.id === configId && option.type === "select"
      ? { ...option, currentValue: value }
      : option,
  );
}

const initializeResult = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
  },
  agentInfo: { name: "fx", title: "fx", version: "0.0.13" },
  authMethods: [],
};

const openReplay = Effect.fn("openFxReplay")(function* (input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<ReplayEntry>;
  readonly initialNativeThreadId?: string;
  readonly runtimeMode?: RuntimeMode;
  readonly model?: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string }>;
  readonly fxDefaultModel?: string;
}) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const replayDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fx-adapter-" });
  const statusPath = path.join(replayDir, "status.json");
  const transcript = yield* decodeAcpReplayTranscript(
    {
      provider: FX_DRIVER_KIND,
      protocol: ACP_PROTOCOL,
      version: "1",
      scenario: input.scenario,
      entries: input.entries,
    },
    FX_DRIVER_KIND,
  );
  const instanceId = ProviderInstanceId.make("fx");
  const adapter = yield* makeFxAdapterV2({
    instanceId,
    settings: decodeFxSettings({ enabled: true }),
    environment: {},
    selfInvocation: yield* resolveSelfInvocation(),
    ...(input.fxDefaultModel === undefined
      ? {}
      : { currentFxDefaultModel: Effect.succeed(input.fxDefaultModel) }),
    makeRuntime: makeAcpReplayRuntime({
      transcript,
      statusPath,
      scriptPath: yield* path.fromFileUrl(
        new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
      ),
      childProcessSpawner,
      fileSystem,
      cancelBehavior: FX_ACP_CANCEL_BEHAVIOR,
    }),
  });
  yield* adapter
    .openSession({
      threadId: ThreadId.make("thread-fx"),
      providerSessionId: ProviderSessionId.make("provider-session-fx"),
      modelSelection: {
        instanceId,
        model: input.model ?? "anthropic/claude-sonnet-5.5",
        ...(input.options === undefined
          ? { options: [{ id: "effort", value: "high" }] }
          : { options: input.options }),
      },
      runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: input.runtimeMode ?? "auto",
        interactionMode: "default",
        cwd: replayDir,
      }),
      ...(input.initialNativeThreadId === undefined
        ? {}
        : { initialNativeThreadId: input.initialNativeThreadId }),
    })
    .pipe(Effect.scoped);
  yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
});

describe("FxAdapterV2", () => {
  it("does not switch runtime mode or steer in session", () => {
    assert.equal(FxProviderCapabilitiesV2.sessions.supportsRuntimeModeSwitchInSession, false);
    assert.equal(FxProviderCapabilitiesV2.turns.supportsActiveSteering, false);
  });

  it.effect("writes model, effort, and the advertised auto mode after session/new", () =>
    openReplay({
      scenario: "fx-session-new-config",
      entries: [
        outbound("initialize"),
        answer("initialize", initializeResult),
        outbound("session/new"),
        answer("session/new", { sessionId: "fx-session", configOptions: recordedConfigOptions }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "model",
          value: "anthropic/claude-sonnet-5.5",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("model", "anthropic/claude-sonnet-5.5"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "effort",
          value: "high",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("effort", "high"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "mode",
          value: "code",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("mode", "code"),
        }),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("writes medium effort when the thread stored none", () =>
    openReplay({
      scenario: "fx-session-new-default-effort",
      options: [],
      entries: [
        outbound("initialize"),
        answer("initialize", initializeResult),
        outbound("session/new"),
        answer("session/new", { sessionId: "fx-session", configOptions: recordedConfigOptions }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "model",
          value: "anthropic/claude-sonnet-5.5",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("model", "anthropic/claude-sonnet-5.5"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "effort",
          value: "medium",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent(
            "effort",
            "medium",
            withCurrent("model", "anthropic/claude-sonnet-5.5"),
          ),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "mode",
          value: "code",
        }),
        answer("session/set_config_option", { configOptions: withCurrent("mode", "code") }),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("writes ask on a supervised session/load", () =>
    openReplay({
      scenario: "fx-session-load-ask",
      runtimeMode: "approval-required",
      initialNativeThreadId: "fx-session",
      entries: [
        outbound("initialize"),
        answer("initialize", initializeResult),
        outbound("session/load"),
        answer("session/load", { sessionId: "fx-session", configOptions: recordedConfigOptions }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "model",
          value: "anthropic/claude-sonnet-5.5",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("model", "anthropic/claude-sonnet-5.5"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "effort",
          value: "high",
        }),
        answer("session/set_config_option", { configOptions: withCurrent("effort", "high") }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "mode",
          value: "ask",
        }),
        answer("session/set_config_option", { configOptions: withCurrent("mode", "ask") }),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("resolves default to the probed fx model and never sends the sentinel", () =>
    openReplay({
      scenario: "fx-session-default-model",
      model: "default",
      options: [],
      fxDefaultModel: "anthropic/claude-opus-5.5",
      runtimeMode: "approval-required",
      entries: [
        outbound("initialize"),
        answer("initialize", initializeResult),
        outbound("session/new"),
        answer("session/new", { sessionId: "fx-session", configOptions: recordedConfigOptions }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "effort",
          value: "medium",
        }),
        answer("session/set_config_option", { configOptions: withCurrent("effort", "medium") }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "mode",
          value: "ask",
        }),
        answer("session/set_config_option", { configOptions: withCurrent("mode", "ask") }),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
