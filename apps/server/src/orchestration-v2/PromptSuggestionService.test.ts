import { assert, describe, it, vi } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  RunId,
  TextGenerationError,
  ThreadId,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as PromptSuggestion from "./PromptSuggestionService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread:prompt-suggestion");
const projectId = ProjectId.make("project:prompt-suggestion");
const firstRun = RunId.make("run:first");
const latestRun = RunId.make("run:latest");

function message(
  id: string,
  runId: RunId | null,
  role: "user" | "assistant" | "system",
  text: string,
  streaming = false,
) {
  return { id: MessageId.make(id), threadId, runId, role, text, streaming, attachments: [] };
}

function makeHarness(
  options: {
    readonly enabled?: boolean;
    readonly latestStatus?: OrchestrationV2RunStatus;
    readonly generate?: TextGeneration.TextGeneration["Service"]["generatePromptSuggestion"];
  } = {},
) {
  const records = {
    thread: { id: threadId, projectId, worktreePath: "/worktree", historyOrigin: "native" },
    runs: [
      { id: firstRun, ordinal: 1, status: "completed" },
      { id: RunId.make("run:rolled-back"), ordinal: 3, status: "rolled_back" },
      { id: latestRun, ordinal: 2, status: options.latestStatus ?? "completed" },
    ],
    messages: [
      message("m1", firstRun, "user", "Add a dark mode toggle"),
      message("m2", firstRun, "assistant", "Added the toggle. Want me to persist the choice?"),
      message("m3", RunId.make("run:rolled-back"), "user", "Undone request"),
      message("m4", latestRun, "user", "Yes, persist it"),
      message("m5", latestRun, "system", "Context compacted"),
      message("m6", latestRun, "assistant", "Persisted it in localStorage."),
      message("m7", latestRun, "assistant", "", true),
    ],
  };
  const getThreadRecords = vi.fn(() => Effect.succeed(records));
  const generatePromptSuggestion = vi.fn(
    options.generate ?? (() => Effect.succeed({ suggestion: "Run the tests" })),
  );
  const layer = PromptSuggestion.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords:
            getThreadRecords as unknown as ThreadManagement.ThreadManagementService["Service"]["getThreadRecords"],
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () => Effect.succeedSome({ workspaceRoot: "/repo" } as ProjectStore.ProjectRow),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(TextGeneration.TextGeneration)({ generatePromptSuggestion }),
        ServerSettings.layerTest({ promptSuggestionsEnabled: options.enabled ?? true }),
      ),
    ),
  );
  return { layer, getThreadRecords, generatePromptSuggestion };
}

const generate = (runId: RunId) =>
  PromptSuggestion.PromptSuggestionService.pipe(
    Effect.flatMap((service) => service.generate({ threadId, runId })),
  );

describe("PromptSuggestionService", () => {
  it.effect("does not read the thread or run a model while suggestions are off", () => {
    const harness = makeHarness({ enabled: false });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* generate(latestRun), { suggestion: null });
      assert.strictEqual(harness.getThreadRecords.mock.calls.length, 0);
      assert.strictEqual(harness.generatePromptSuggestion.mock.calls.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("generates once per completed latest run from its settled conversation", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const [first, second] = yield* Effect.all([generate(latestRun), generate(latestRun)], {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(first, { suggestion: "Run the tests" });
      assert.deepStrictEqual(second, first);
      assert.deepStrictEqual(yield* generate(latestRun), first);
      assert.strictEqual(harness.generatePromptSuggestion.mock.calls.length, 1);
      assert.deepStrictEqual(harness.generatePromptSuggestion.mock.calls[0]?.[0], {
        cwd: "/worktree",
        messages: [
          { role: "user", text: "Add a dark mode toggle" },
          { role: "assistant", text: "Added the toggle. Want me to persist the choice?" },
          { role: "user", text: "Yes, persist it" },
          { role: "assistant", text: "Persisted it in localStorage." },
        ],
        modelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect.each([
    { name: "a run that is no longer the latest", runId: firstRun },
    { name: "an interrupted latest run", runId: latestRun, latestStatus: "interrupted" as const },
    { name: "a failed latest run", runId: latestRun, latestStatus: "failed" as const },
  ])("suggests nothing after $name", ({ runId, latestStatus }) => {
    const harness = makeHarness(latestStatus === undefined ? {} : { latestStatus });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* generate(runId), { suggestion: null });
      assert.strictEqual(harness.generatePromptSuggestion.mock.calls.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("resolves a failed generation to no suggestion without retrying it", () => {
    const harness = makeHarness({
      generate: () =>
        Effect.fail(
          new TextGenerationError({ operation: "generatePromptSuggestion", detail: "offline" }),
        ),
    });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* generate(latestRun), { suggestion: null });
      assert.deepStrictEqual(yield* generate(latestRun), { suggestion: null });
      assert.strictEqual(harness.generatePromptSuggestion.mock.calls.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });
});
