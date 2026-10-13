import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { ACP_PROTOCOL } from "@t3tools/provider-acp/server/adapter";
import { FxSettings } from "@t3tools/provider-fx/settings";
import { FX_DRIVER_KIND, makeFxAdapterV2 } from "@t3tools/provider-fx/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const SESSION_ID = "fx-session-01";
const ENABLED_FX_SETTINGS = Schema.decodeSync(FxSettings)({ enabled: true });
/** The model `fx status --json` reports. */
const FX_DEFAULT_MODEL = "anthropic/claude-opus-5.5";
const NAMED_MODEL = "anthropic/claude-sonnet-5.5";
const CUSTOM_MODEL = "openai/gpt-6.1-sol";
const FX_0_0_13_MODES = ["code", "ask"];
/** fx `main` after vercel-labs/fx#1189. */
const FX_MAIN_MODES = ["auto", "ask", "full-access"];

type Frame = Record<string, unknown>;
const outbound = (method: string, params: unknown = "<any>"): Frame => ({
  type: "expect_outbound",
  label: method,
  frame: { kind: "request", method, params },
});
const answer = (method: string, result: unknown): Frame => ({
  type: "emit_inbound",
  label: `${method}.result`,
  frame: { kind: "response", method, result },
});

const select = (
  id: string,
  category: string,
  currentValue: string,
  values: ReadonlyArray<string>,
) => ({
  id,
  name: id,
  category,
  type: "select",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});

/**
 * fx's session config as recorded from 0.0.13 (fixtures/simple), models
 * trimmed. fx lists its backend `provider` before `model`, both with
 * category `model`.
 */
const fxConfig = (input: {
  readonly model: string;
  readonly modes: ReadonlyArray<string>;
  readonly mode?: string;
}) => [
  select("provider", "model", "gateway", ["gateway", "codex", "grok"]),
  select("model", "model", input.model, [NAMED_MODEL, FX_DEFAULT_MODEL, "openai/gpt-5.6-sol"]),
  select("mode", "mode", input.mode ?? "ask", input.modes),
  select("effort", "thought_level", "xhigh", ["auto", "low", "medium", "high", "xhigh", "max"]),
];

/**
 * fx's reply to `session/new` or `session/load`. fx 0.0.13 reports `ask`
 * while it enforces its saved default until a client writes the mode.
 */
const fxSession = (input: { readonly model: string; readonly modes: ReadonlyArray<string> }) => ({
  sessionId: SESSION_ID,
  configOptions: fxConfig(input),
  modes: { currentModeId: "ask", availableModes: input.modes.map((id) => ({ id, name: id })) },
});

const initialize: ReadonlyArray<Frame> = [
  outbound("initialize"),
  answer("initialize", {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
    },
    agentInfo: { name: "fx", title: "fx", version: "0.0.13" },
    authMethods: [],
  }),
];

/** A config write and fx's reply, which lists the session's config after it. */
const setConfig = (
  configId: string,
  value: string,
  configAfter: ReadonlyArray<unknown>,
): ReadonlyArray<Frame> => [
  outbound("session/set_config_option", { sessionId: SESSION_ID, configId, value }),
  answer("session/set_config_option", { configOptions: configAfter }),
];

/**
 * Opens an fx session against a scripted ACP agent, which fails on any
 * frame the script does not expect. Every scripted frame must be used.
 */
const openFxSession = Effect.fn("openFxSession")(function* (input: {
  readonly scenario: string;
  readonly frames: ReadonlyArray<Frame>;
  readonly runtimeMode: RuntimeMode;
  readonly model?: string;
  /** Loads this fx session instead of creating one. */
  readonly loadSessionId?: string;
}) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const replayDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: `t3-fx-${input.scenario}-`,
  });
  const statusPath = path.join(replayDir, "status.json");
  const transcript = yield* decodeAcpReplayTranscript(
    {
      provider: FX_DRIVER_KIND,
      protocol: ACP_PROTOCOL,
      version: "1",
      scenario: input.scenario,
      entries: input.frames as never,
    },
    FX_DRIVER_KIND,
  );
  const instanceId = ProviderInstanceId.make(`fx-${input.scenario}`);
  const adapter = yield* makeFxAdapterV2({
    instanceId,
    settings: ENABLED_FX_SETTINGS,
    environment: {},
    selfInvocation: yield* resolveSelfInvocation(),
    defaultModel: Effect.succeed(FX_DEFAULT_MODEL),
    makeRuntime: makeAcpReplayRuntime({
      transcript,
      statusPath,
      scriptPath: yield* path.fromFileUrl(
        new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
      ),
      childProcessSpawner,
      fileSystem,
    }),
  });
  yield* adapter
    .openSession({
      threadId: ThreadId.make(`thread-fx-${input.scenario}`),
      providerSessionId: ProviderSessionId.make(`provider-session-fx-${input.scenario}`),
      // The thread's effort matches the session's, so no effort write is scripted.
      modelSelection: {
        instanceId,
        model: input.model ?? "default",
        options: [{ id: "effort", value: "xhigh" }],
      },
      runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: input.runtimeMode,
        interactionMode: "default",
        cwd: replayDir,
      }),
      ...(input.loadSessionId === undefined ? {} : { initialNativeThreadId: input.loadSessionId }),
    })
    .pipe(Effect.scoped);
  yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
});

describe("FxAdapterV2", () => {
  it.effect("runs Auto as fx's `code` mode on 0.0.13 and as `auto` where fx advertises it", () =>
    Effect.forEach(
      [
        { scenario: "auto-0-0-13", modes: FX_0_0_13_MODES, written: "code" },
        { scenario: "auto-main", modes: FX_MAIN_MODES, written: "auto" },
      ],
      ({ scenario, modes, written }) =>
        openFxSession({
          scenario,
          runtimeMode: "auto",
          frames: [
            ...initialize,
            outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
            answer("session/new", fxSession({ model: FX_DEFAULT_MODEL, modes })),
            ...setConfig(
              "mode",
              written,
              fxConfig({ model: FX_DEFAULT_MODEL, modes, mode: written }),
            ),
          ],
        }),
      { discard: true },
    ).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("puts a loaded session that ran a named model back on fx's default for Default", () =>
    openFxSession({
      scenario: "default-model",
      runtimeMode: "approval-required",
      model: "default",
      loadSessionId: SESSION_ID,
      frames: [
        ...initialize,
        outbound("session/load"),
        answer("session/load", fxSession({ model: NAMED_MODEL, modes: FX_0_0_13_MODES })),
        // Config id `model`, never fx's `provider`, and never T3's "default".
        ...setConfig(
          "model",
          FX_DEFAULT_MODEL,
          fxConfig({ model: FX_DEFAULT_MODEL, modes: FX_0_0_13_MODES }),
        ),
        // Written on load even though fx reports ask.
        ...setConfig("mode", "ask", fxConfig({ model: FX_DEFAULT_MODEL, modes: FX_0_0_13_MODES })),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  // fx 0.0.13's gateway takes any model id (src/acp/server.zig
  // handleSetConfigOption) and lists the current one even when its catalog
  // does not, so a custom model reaches fx instead of running on another.
  it.effect("sends a custom model fx does not list", () =>
    openFxSession({
      scenario: "custom-model",
      runtimeMode: "approval-required",
      model: CUSTOM_MODEL,
      frames: [
        ...initialize,
        outbound("session/new"),
        answer("session/new", fxSession({ model: FX_DEFAULT_MODEL, modes: FX_0_0_13_MODES })),
        ...setConfig(
          "model",
          CUSTOM_MODEL,
          fxConfig({ model: CUSTOM_MODEL, modes: FX_0_0_13_MODES }),
        ),
        ...setConfig("mode", "ask", fxConfig({ model: CUSTOM_MODEL, modes: FX_0_0_13_MODES })),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
