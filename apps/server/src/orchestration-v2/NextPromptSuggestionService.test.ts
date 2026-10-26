import { assert, describe, it, vi } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as NextPromptSuggestion from "./NextPromptSuggestionService.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:next-prompt");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in next prompt tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

function makeHarness(
  options: {
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
    readonly generate?: TextGeneration.TextGeneration["Service"]["generateNextPrompt"];
  } = {},
) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "next-prompt-suggestion" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest({
    nextPromptSuggestionsEnabled: true,
    ...options.settings,
  });
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const generateNextPrompt = vi.fn(
    options.generate ?? (() => Effect.succeed({ suggestion: "Add a test for the stale case" })),
  );
  const layerProjectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: "Project",
              workspaceRoot: "/repo",
              defaultModelSelection: modelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              createdAt: "2026-06-20T00:00:00.000Z",
              updatedAt: "2026-06-20T00:00:00.000Z",
              deletedAt: null,
            })
          : Option.none(),
      ),
  });
  const layerSuggestions = NextPromptSuggestion.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreadManagement,
        layerProjectedProjects,
        Layer.mock(TextGeneration.TextGeneration)({ generateNextPrompt }),
        layerServerSettings,
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(
      layerOrchestrator,
      layerThreadManagement,
      layerSuggestions,
      layerDatabase,
    ),
    generateNextPrompt,
  };
}

function createThread(input: { readonly command: string; readonly thread: string }) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make(input.thread);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(input.command),
      threadId,
      projectId,
      title: "Seed title",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });
}

// Messages written together share a timestamp and then sort by id, so ids must follow the conversation.
const messageIdOf = (runId: RunId, role: "user" | "assistant") =>
  MessageId.make(`${runId}:${role === "user" ? "1-user" : "2-assistant"}`);

/** Records a settled source run with one exchange, as a provider turn would. */
function recordRun(input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly user: string;
  readonly assistant: string;
  readonly status?: "completed" | "rolled_back";
}) {
  return Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make(`${input.threadId}:provider`);
    const message = (role: "user" | "assistant", text: string) => {
      const createdAt = now;
      return {
        id: EventId.make(messageIdOf(input.runId, role)),
        type: "message.updated" as const,
        threadId: input.threadId,
        runId: input.runId,
        occurredAt: createdAt,
        payload: {
          id: messageIdOf(input.runId, role),
          threadId: input.threadId,
          runId: input.runId,
          nodeId: null,
          role,
          text,
          attachments: [],
          streaming: false,
          createdBy: "user" as const,
          creationSource: "web" as const,
          createdAt,
          updatedAt: createdAt,
        },
      };
    };
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${input.runId}:created`),
          type: "run.created",
          threadId: input.threadId,
          runId: input.runId,
          occurredAt: now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: input.ordinal,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: messageIdOf(input.runId, "user"),
            rootNodeId: null,
            activeAttemptId: null,
            status: input.status ?? "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make(`${input.runId}:provider-thread`),
          type: "provider-thread.updated",
          threadId: input.threadId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver: adapter.driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: input.threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver: adapter.driver, nativeId: "native", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: input.ordinal,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        message("user", input.user),
        message("assistant", input.assistant),
      ],
    });
  });
}

const assistantOf = (runId: RunId) => messageIdOf(runId, "assistant");

function seedExchange(input: {
  readonly thread: string;
  readonly user: string;
  readonly assistant: string;
}) {
  return Effect.gen(function* () {
    const threadId = yield* createThread({
      command: `command:${input.thread}:create`,
      thread: input.thread,
    });
    const runId = RunId.make(`run:${input.thread}:1`);
    yield* recordRun({
      threadId,
      runId,
      ordinal: 1,
      user: input.user,
      assistant: input.assistant,
    });
    return { threadId, runId };
  });
}

describe("NextPromptSuggestionService", () => {
  it.effect("asks the text generation model about the thread and returns its suggestion", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ settings: { nextPromptInstructions: "Answer in Polish." } });
      yield* Effect.gen(function* () {
        const suggestions = yield* NextPromptSuggestion.NextPromptSuggestionService;
        const { threadId, runId } = yield* seedExchange({
          thread: "thread:next:ask",
          user: "Fix the flaky sidebar test",
          assistant: "Fixed. I can also add a regression test for the race.",
        });

        const result = yield* suggestions.suggest({ threadId, afterMessageId: assistantOf(runId) });

        assert.deepEqual(result, { suggestion: "Add a test for the stale case" });
        assert.equal(harness.generateNextPrompt.mock.calls.length, 1);
        const call = harness.generateNextPrompt.mock.calls[0]![0];
        assert.equal(call.cwd, "/repo");
        assert.equal(call.instructions, "Answer in Polish.");
        assert.deepEqual(call.modelSelection, DEFAULT_SERVER_SETTINGS.textGenerationModelSelection);
        assert.isTrue(call.message.includes("USER:\nFix the flaky sidebar test"));
        assert.isTrue(call.message.includes("ASSISTANT:\nFixed. I can also add a regression test"));
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("makes no model call while the setting is off", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ settings: { nextPromptSuggestionsEnabled: false } });
      yield* Effect.gen(function* () {
        const suggestions = yield* NextPromptSuggestion.NextPromptSuggestionService;
        const { threadId, runId } = yield* seedExchange({
          thread: "thread:next:off",
          user: "Hello",
          assistant: "Hi there",
        });

        const result = yield* suggestions.suggest({ threadId, afterMessageId: assistantOf(runId) });

        assert.deepEqual(result, { suggestion: null });
        assert.equal(harness.generateNextPrompt.mock.calls.length, 0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("drops a request for a reply the user has already moved past", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const suggestions = yield* NextPromptSuggestion.NextPromptSuggestionService;
        const { threadId, runId } = yield* seedExchange({
          thread: "thread:next:stale",
          user: "First question",
          assistant: "First answer",
        });
        yield* TestClock.adjust("1 second");
        yield* recordRun({
          threadId,
          runId: RunId.make("run:thread:next:stale:2"),
          ordinal: 2,
          user: "Second question",
          assistant: "Second answer",
        });

        const result = yield* suggestions.suggest({ threadId, afterMessageId: assistantOf(runId) });

        assert.deepEqual(result, { suggestion: null });
        assert.equal(harness.generateNextPrompt.mock.calls.length, 0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("ignores a reply from a rolled-back run", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const suggestions = yield* NextPromptSuggestion.NextPromptSuggestionService;
        const { threadId } = yield* seedExchange({
          thread: "thread:next:rollback",
          user: "First question",
          assistant: "First answer",
        });
        yield* TestClock.adjust("1 second");
        const rolledBack = RunId.make("run:thread:next:rollback:2");
        yield* recordRun({
          threadId,
          runId: rolledBack,
          ordinal: 2,
          user: "Second question",
          assistant: "Second answer",
          status: "rolled_back",
        });

        const result = yield* suggestions.suggest({
          threadId,
          afterMessageId: assistantOf(rolledBack),
        });

        assert.deepEqual(result, { suggestion: null });
        assert.equal(harness.generateNextPrompt.mock.calls.length, 0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("returns no suggestion when generation fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generate: () =>
          Effect.fail(
            new TextGenerationError({ operation: "generateNextPrompt", detail: "model offline" }),
          ),
      });
      yield* Effect.gen(function* () {
        const suggestions = yield* NextPromptSuggestion.NextPromptSuggestionService;
        const { threadId, runId } = yield* seedExchange({
          thread: "thread:next:fail",
          user: "Hello",
          assistant: "Hi there",
        });

        const result = yield* suggestions.suggest({ threadId, afterMessageId: assistantOf(runId) });

        assert.deepEqual(result, { suggestion: null });
        assert.equal(harness.generateNextPrompt.mock.calls.length, 1);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
