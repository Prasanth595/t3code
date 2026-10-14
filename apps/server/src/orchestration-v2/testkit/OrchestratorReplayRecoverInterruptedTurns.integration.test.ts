import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  type ProviderReplayEntry,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  ClaudeOrchestratorReplayHarness,
  makeClaudeRestartReplayHarness,
} from "../Adapters/ClaudeAdapterV2.testkit.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EffectWorker from "../EffectWorker.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT } from "./fixtures/claude_background_subagent_after_root/input.ts";
import {
  CLAUDE_MODEL_SELECTION,
  materializeFixtureInput,
  projectionFor,
} from "./fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { runOrchestratorV2Scenario } from "./OrchestratorScenario.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";

const SCENARIO = "claude_background_subagent_after_root";
const SESSION_ID = "cca274e4-25ae-4171-b972-bbb31118517e";
const RECOVERY = DEFAULT_SERVER_SETTINGS.recoverInterruptedTurnsMessage;
const NOTE = [
  "Note: the T3 server restarted, and this background work was cancelled before it finished. It will not report back:",
  "- subagent: Background subagent test",
].join("\n");

/**
 * The recorded session where the root turn finished and left a native
 * background subagent running, then the server died. When `recoveryPrompt` is
 * set, the restarted server resumes the native session and must send exactly
 * that prompt; the replay rejects any other frame.
 */
const readRestartTranscript = Effect.fn("readRestartTranscript")(function* (
  recoveryPrompt: string | undefined,
) {
  const recorded = yield* readProviderReplayTranscript(
    new URL(`./fixtures/${SCENARIO}/claude_transcript.ndjson`, import.meta.url),
  );
  const rootResult = recorded.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "result",
  );
  const queryOpen = recorded.entries[0];
  const openFrame = queryOpen?.type === "expect_outbound" ? queryOpen.frame : undefined;
  const queryOptions: unknown =
    typeof openFrame === "object" && openFrame !== null
      ? Reflect.get(openFrame, "options")
      : undefined;
  if (typeof queryOptions !== "object" || queryOptions === null) {
    throw new Error(`${SCENARIO} must open with a recorded query.open frame.`);
  }
  const { sessionId: _sessionId, ...resumeOptions } = queryOptions as Record<string, unknown>;
  const recoveryTurn = (text: string): ReadonlyArray<ProviderReplayEntry> => [
    {
      type: "expect_outbound",
      label: "query.open:resume",
      frame: { type: "query.open", options: { ...resumeOptions, resume: SESSION_ID } },
    },
    {
      type: "expect_outbound",
      label: "prompt.offer:recovery",
      frame: {
        type: "prompt.offer",
        message: {
          type: "user",
          message: { role: "user", content: text },
          parent_tool_use_id: null,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "result:recovery",
      frame: {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        result: "RECOVERED",
        stop_reason: "end_turn",
        duration_ms: 1,
        duration_api_ms: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        session_id: SESSION_ID,
        uuid: "recovery-result",
      },
    },
  ];
  return yield* ClaudeOrchestratorReplayHarness.decodeTranscript({
    ...recorded,
    entries: [
      ...recorded.entries.slice(0, rootResult + 1),
      // The server dies here, with the background subagent still running.
      { type: "runtime_exit", status: "success" },
      ...(recoveryPrompt === undefined ? [] : recoveryTurn(recoveryPrompt)),
    ],
  });
});

const runRestart = Effect.fn("runRestart")(function* (input: {
  readonly recoverInterruptedTurns: boolean;
}) {
  const transcript = yield* readRestartTranscript(
    input.recoverInterruptedTurns ? `${NOTE}\n\n${RECOVERY}` : undefined,
  );
  const workspace = yield* checkpointWorkspace(SCENARIO);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: "t3-orchestration-v2-recover-interrupted-" }),
    (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
  );
  const materialized = yield* materializeFixtureInput({
    scenario: SCENARIO,
    fixtureInput: {
      steps: [{ type: "message", text: CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT }],
    },
    driver: ProviderDriverKind.make("claudeAgent"),
    modelSelection: CLAUDE_MODEL_SELECTION,
  });
  const idle = materialized.steps.find((step) => step.type === "await_thread_idle");
  assert.isDefined(idle);
  const { harness, assertComplete } = makeClaudeRestartReplayHarness(transcript);
  const layerDatabase = SqlitePersistence.layerFromPath(path.join(tempDir, "state.sqlite")).pipe(
    Layer.provide(NodeServices.layer),
  );
  const scenario = (name: string, steps: typeof materialized.steps) => ({
    name: `${SCENARIO}:${name}`,
    transcript,
    commands: steps.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
    steps,
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: { cwd: workspace },
  });

  const before = yield* Effect.scoped(
    runOrchestratorV2ProviderReplayScenario(
      scenario("before-restart", materialized.steps),
      harness,
      {
        databaseLayer: layerDatabase,
      },
    ),
  );
  const settled = projectionFor(before, SCENARIO);
  assert.equal(settled.runs[0]?.status, "completed");
  assert.equal(settled.subagents[0]?.status, "running");

  // The next server start: recovery, then the effect worker sends the message.
  const restartScenario = scenario("restarted", [idle!]);
  const restarted = yield* Effect.scoped(
    Effect.gen(function* () {
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      return yield* runOrchestratorV2Scenario(restartScenario);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerProviderReplay(restartScenario, harness, {
          databaseLayer: layerDatabase,
          recoverOnStartup: true,
          recoverInterruptedTurns: input.recoverInterruptedTurns,
        }),
      ),
    ),
  );
  // The replay runner rejects any prompt frame that differs from the transcript.
  yield* assertComplete;
  return projectionFor(restarted, SCENARIO);
});

describe("recoverInterruptedTurns", () => {
  it.effect("wakes a finished turn whose native background subagent the restart killed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* runRestart({ recoverInterruptedTurns: true });
        assert.equal(projection.subagents[0]?.status, "cancelled");
        assert.deepEqual(
          projection.runs.map((run) => run.status),
          ["completed", "completed"],
        );
        const recovery = projection.messages.find(
          (message) => message.id === projection.runs[1]?.userMessageId,
        );
        // A continuation of the cut run, as upstream sends it, so a waiter follows the new run.
        assert.equal(projection.runs[1]?.restartContinuationOfRunId, projection.runs[0]?.id);
        assert.equal(recovery?.text, `${NOTE}\n\n${RECOVERY}`);
        assert.equal(recovery?.notification?.source.kind, "system");
      }).pipe(
        provideDeterministicTestRuntime,
        Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
      ),
    ),
  );

  it.effect("leaves the thread asleep when the switch is off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* runRestart({ recoverInterruptedTurns: false });
        assert.equal(projection.subagents[0]?.status, "cancelled");
        assert.deepEqual(
          projection.runs.map((run) => run.status),
          ["completed"],
        );
      }).pipe(
        provideDeterministicTestRuntime,
        Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
      ),
    ),
  );
});
