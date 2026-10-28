import {
  PromptSuggestionError,
  type PromptSuggestionInput,
  type PromptSuggestionResult,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import type { PromptSuggestionMessage } from "@t3tools/provider-core/server/textGeneration";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const MAX_CONTEXT_MESSAGES = 24;
const NO_SUGGESTION: PromptSuggestionResult = { suggestion: null };

export class PromptSuggestionService extends Context.Service<
  PromptSuggestionService,
  {
    /** Suggests the user's next prompt after the thread's latest run completed. */
    readonly generate: (
      input: PromptSuggestionInput,
    ) => Effect.Effect<PromptSuggestionResult, PromptSuggestionError>;
  }
>()("t3/orchestration-v2/PromptSuggestionService") {}

class SuggestionKey extends Data.Class<{ threadId: ThreadId; runId: RunId }> {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const readSettledThread = Effect.fn("PromptSuggestionService.readSettledThread")(function* (
    key: SuggestionKey,
  ) {
    const source = yield* threads.getThreadRecords(key.threadId, ["messages", "runs"], {
      messageRoles: ["user", "assistant"],
    });
    const runs = source.runs.filter((run) => run.status !== "rolled_back");
    const latest = runs.reduce<(typeof runs)[number] | undefined>(
      (best, run) => (best === undefined || run.ordinal > best.ordinal ? run : best),
      undefined,
    );
    // Interrupted or failed runs have no reply worth following up on.
    if (latest?.id !== key.runId || latest.status !== "completed") return Option.none();
    const liveRunIds = new Set(runs.map((run) => run.id));
    const messages = source.messages.flatMap((message): Array<PromptSuggestionMessage> => {
      if (message.streaming || message.role === "system") return [];
      if (
        message.runId === null
          ? source.thread.historyOrigin !== "v1_import"
          : !liveRunIds.has(message.runId)
      ) {
        return [];
      }
      return [{ role: message.role, text: message.text }];
    });
    return messages.at(-1)?.role === "assistant"
      ? Option.some({ thread: source.thread, messages: messages.slice(-MAX_CONTEXT_MESSAGES) })
      : Option.none();
  });

  const lookup = Effect.fn("PromptSuggestionService.lookup")(function* (key: SuggestionKey) {
    const settled = yield* readSettledThread(key);
    if (Option.isNone(settled)) return NO_SUGGESTION;
    const { thread, messages } = settled.value;
    const project = yield* projects.get(thread.projectId);
    if (Option.isNone(project)) return NO_SUGGESTION;
    const settings = yield* serverSettings.getSettings;
    const projectSettings = resolveProjectSettings(settings, thread.projectId).settings;
    const modelSelection = ServerSettings.resolvePromptSuggestionModelSelection(
      projectSettings,
      yield* providerRegistry.getProviders,
      thread.projectId,
    );
    return yield* textGeneration.generatePromptSuggestion({
      cwd: thread.worktreePath ?? project.value.workspaceRoot,
      messages,
      modelSelection,
    });
  });

  // One generation per run, shared by every client viewing the thread. Failures resolve to no
  // suggestion so a broken provider is not retried on every render.
  const suggestions = yield* Cache.make({
    capacity: 256,
    timeToLive: "30 minutes",
    lookup: (key: SuggestionKey) =>
      lookup(key).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Prompt suggestion failed", {
                threadId: key.threadId,
                runId: key.runId,
                cause,
              }).pipe(Effect.as(NO_SUGGESTION)),
        ),
      ),
  });

  const generate: PromptSuggestionService["Service"]["generate"] = Effect.fn(
    "PromptSuggestionService.generate",
  )(function* (input) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new PromptSuggestionError({
            threadId: input.threadId,
            message: "Could not read the server settings.",
            cause,
          }),
      ),
    );
    if (!settings.promptSuggestionsEnabled) return NO_SUGGESTION;
    return yield* Cache.get(
      suggestions,
      new SuggestionKey({ threadId: input.threadId, runId: input.runId }),
    );
  });

  return PromptSuggestionService.of({ generate });
});

export const layer = Layer.effect(PromptSuggestionService, make);
