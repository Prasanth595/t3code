import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ProviderReplayTranscript } from "@t3tools/contracts";
import { makeAcpRegistryRuntime } from "@t3tools/provider-acp-registry/testing";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import { GlmSettings } from "@t3tools/provider-glm/settings";
import {
  GLM_DEFAULT_INSTANCE_ID,
  GLM_PROVIDER,
  makeGlmAdapterV2,
} from "@t3tools/provider-glm/testing";
import { ACP_PROTOCOL } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ProviderAdapterRegistry from "../src/orchestration-v2/ProviderAdapterRegistry.ts";
import { GlmOrchestratorReplayHarness } from "../src/orchestration-v2/Adapters/GlmAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/index.ts";
import { assertGlmProviderThreadResumeOutput } from "../src/orchestration-v2/testkit/fixtures/provider_thread_resume/glm_output.ts";
import { materializeFixtureInput } from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { runOrchestratorV2Scenario } from "../src/orchestration-v2/testkit/OrchestratorScenario.ts";
import { runReplayFixture } from "../src/orchestration-v2/testkit/ProviderReplayFixtures.ts";
import * as ProviderReplayHarness from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeAcpWireRecorder, recordedAcpEntries } from "./acpReplayRecorder.ts";

const wallClock = Clock.Clock.defaultValue();
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeEffect(GlmSettings);
const RECORDABLE_SCENARIOS = new Set([
  "simple",
  "multi_turn",
  "queued_turn",
  "turn_interrupt",
  "message_steering",
  "provider_thread_resume",
  "tool_call_read_only",
  "tool_call_read_only_on_request",
]);

function readArgValues(name: string) {
  const args = process.argv.slice(2);
  return args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]!] : []));
}

const recordScenario = Effect.fn("recordGlmScenario")(function* (fixtureName: string) {
  if (!RECORDABLE_SCENARIOS.has(fixtureName)) {
    return yield* Effect.die(new Error(`Unsupported GLM recording scenario '${fixtureName}'.`));
  }
  const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((candidate) => candidate.name === fixtureName);
  if (fixture === undefined)
    return yield* Effect.die(new Error(`Unknown fixture '${fixtureName}'.`));
  const reference =
    fixture.providers.find((provider) => provider.driver === "acpRegistry") ??
    (fixtureName === "provider_thread_resume" ? fixture.providers[0] : undefined);
  if (reference === undefined)
    return yield* Effect.die(new Error("Fixture has no provider variant."));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const transcriptFile = new URL(
    `../src/orchestration-v2/testkit/fixtures/${fixtureName}/glm_transcript.ndjson`,
    import.meta.url,
  );
  const variant = {
    ...reference,
    driver: GLM_PROVIDER,
    transcriptFile,
    modelSelection: { instanceId: GLM_DEFAULT_INSTANCE_ID, model: "default" },
    assertOutput:
      fixtureName === "provider_thread_resume"
        ? assertGlmProviderThreadResumeOutput
        : reference.assertOutput,
  };
  const fixtureInput = fixture.buildInput();
  const workspace = yield* checkpointWorkspace(fixtureName, fixtureInput.workspaceFiles);
  const realWorkspace = yield* fs.realPath(workspace);
  const materialized = yield* materializeFixtureInput({
    scenario: fixtureName,
    fixtureInput,
    driver: GLM_PROVIDER,
    modelSelection: variant.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
  const scenario = {
    ...materialized,
    name: `${fixtureName}/glm-record`,
    steps: materialized.steps.some(
      (step) =>
        step.type === "release_replay_gate" || step.type === "release_replay_gate_after_waiting",
    )
      ? materialized.steps.filter((step) => step.type === "dispatch")
      : materialized.steps.map((step) =>
          step.type === "finish_held_run" ? { ...step, type: "await_run_status" as const } : step,
        ),
    runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: realWorkspace },
  };
  const tee = makeAcpWireRecorder();
  const nativeHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-glm-recording-home-" });
  const settings = yield* decodeSettings({
    enabled: true,
    ...(process.env.T3_GLM_BIN ? { commandPath: process.env.T3_GLM_BIN } : {}),
  });
  const layerHost = TestProviderHost.layer({ cwd: realWorkspace }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const layerCatalog = AcpRegistrySupport.layerFromHost.pipe(
    Layer.provideMerge(Layer.mergeAll(layerHost, NodeServices.layer, FetchHttpClient.layer)),
  );
  const layerRegistry = ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
      const hostEnvironment = yield* HostProcess.Environment;
      const environment = {
        ...hostEnvironment,
        HOME: nativeHome,
        XDG_CONFIG_HOME: path.join(nativeHome, ".config"),
        XDG_STATE_HOME: path.join(nativeHome, ".local", "state"),
        ACP_GLM_SESSION_DIR: path.join(nativeHome, "sessions"),
      };
      if (!settings.commandPath) yield* catalog.prepare({ agentId: settings.agentId });
      const selfInvocation = yield* resolveSelfInvocation();
      const runtimeOptions = {
        driverKind: GLM_PROVIDER,
        instanceId: GLM_DEFAULT_INSTANCE_ID,
        settings,
        environment,
        selfInvocation,
      };
      const adapter = yield* makeGlmAdapterV2({
        ...runtimeOptions,
        makeRuntime: (input) =>
          makeAcpRegistryRuntime(
            runtimeOptions,
            catalog,
          )({
            ...input,
            protocolLogging: tee.attachRuntime(),
          }),
      });
      const onWallClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, Clock.Clock, wallClock);
      return [
        {
          ...adapter,
          openSession: (input) =>
            adapter.openSession(input).pipe(
              Effect.map((session): ProviderAdapter.ProviderAdapterV2SessionRuntime => ({
                ...session,
                startTurn: (turnInput) => onWallClock(session.startTurn(turnInput)),
                steerTurn: (turnInput) => onWallClock(session.steerTurn(turnInput)),
                interruptTurn: (turnInput) => onWallClock(session.interruptTurn(turnInput)),
                respondToRuntimeRequest: (turnInput) =>
                  onWallClock(session.respondToRuntimeRequest(turnInput)),
              })),
              onWallClock,
            ),
        },
      ];
    }),
  ).pipe(Layer.provide(Layer.mergeAll(layerCatalog, IdAllocator.layer)));
  const scopedRegistry = Layer.unwrap(
    Effect.map(Effect.scope, (scope) =>
      layerRegistry.pipe(Layer.provide(Layer.succeed(Scope.Scope, scope))),
    ),
  );
  const result = yield* runOrchestratorV2Scenario(scenario).pipe(
    Effect.provide(ProviderReplayHarness.layerWithRegistry(scenario, scopedRegistry)),
    provideDeterministicTestRuntime,
    Effect.scoped,
  );
  const transcript = {
    provider: GLM_PROVIDER,
    protocol: ACP_PROTOCOL,
    version: "1",
    scenario: fixtureName,
    metadata: {
      generatedBy: "live-glm-recorder",
      normalization:
        "Session ids use fixed UUIDs; workspace, home, MCP servers, clientInfo, and T3-owned instructions are normalized. Runtime exits separate actual ACP processes. No provider frames are synthesized.",
    },
    entries: recordedAcpEntries({
      processes: tee.processes,
      workspace: realWorkspace,
      home: nativeHome,
      runtimeInstructions: buildRuntimeInstructions({
        harness: "glm",
        model: variant.modelSelection.model,
      }),
      ...(process.env.Z_AI_API_KEY ? { secret: process.env.Z_AI_API_KEY } : {}),
    }),
  } satisfies ProviderReplayTranscript;
  const outputPath = readArgValues("--out")[0] ?? (yield* path.fromFileUrl(transcriptFile));
  const { entries, ...header } = transcript;
  yield* fs.writeFileString(
    outputPath,
    [
      encodeJson({ type: "transcript_start", ...header }),
      ...entries.map((entry) => encodeJson(entry)),
      "",
    ].join("\n"),
  );
  yield* Console.log(`Wrote ${entries.length} GLM ACP replay entries to ${outputPath}`);
  variant.assertOutput(result, transcript);
  yield* runReplayFixture({
    fixtureName,
    buildInput: fixture.buildInput,
    driver: { ...variant, transcriptFile: yield* path.toFileUrl(outputPath) },
    harness: GlmOrchestratorReplayHarness,
  });
  yield* Console.log(`Verified ${fixtureName}/glm through OrchestratorV2.`);
});

const scenarios = readArgValues("--scenario").flatMap((value) => value.split(","));
if (scenarios.length === 0) throw new Error("Pass --scenario <fixture name>[,<fixture name>...]");
if (!process.env.Z_AI_API_KEY?.trim()) {
  throw new Error("Set Z_AI_API_KEY explicitly to record GLM fixtures with isolated credentials.");
}
if (scenarios.length > 1 && readArgValues("--out").length > 0) {
  throw new Error("--out accepts one scenario at a time.");
}
await Effect.runPromise(
  Effect.forEach(scenarios, (name) => Effect.scoped(recordScenario(name)), { discard: true }).pipe(
    Effect.provide(NodeServices.layer),
  ),
);
