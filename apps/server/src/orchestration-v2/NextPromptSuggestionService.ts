import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  type OrchestrationV2SuggestNextPromptInput,
  type OrchestrationV2SuggestNextPromptResult,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const NO_SUGGESTION: OrchestrationV2SuggestNextPromptResult = { suggestion: null };

export class NextPromptSuggestionService extends Context.Service<
  NextPromptSuggestionService,
  {
    readonly suggest: (
      input: OrchestrationV2SuggestNextPromptInput,
    ) => Effect.Effect<
      OrchestrationV2SuggestNextPromptResult,
      OrchestratorV2Error | ProjectStore.ProjectStoreV2Error | ServerSettingsError
    >;
  }
>()("t3/orchestration-v2/NextPromptSuggestionService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const suggest: NextPromptSuggestionService["Service"]["suggest"] = Effect.fn(
    "NextPromptSuggestionService.suggest",
  )(function* (input) {
    const projection = yield* threads.getThreadRecords(input.threadId, ["messages", "runs"], {
      messageRoles: ["user", "assistant"],
    });
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings,
      projection.thread.projectId,
    ).settings;
    if (!settings.nextPromptSuggestionsEnabled) return NO_SUGGESTION;

    const rolledBack = new Set(
      projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
    );
    const messages = projection.messages.filter(
      (message) => !message.streaming && (message.runId === null || !rolledBack.has(message.runId)),
    );
    // A newer message, or a rollback, means the user has moved on from the reply this was asked for.
    const latest = messages.at(-1);
    if (latest?.id !== input.afterMessageId || latest.role !== "assistant") return NO_SUGGESTION;

    const context = formatThreadTitleContext(messages);
    if (context.message.length === 0) return NO_SUGGESTION;

    const project = yield* projects.get(projection.thread.projectId);
    if (Option.isNone(project)) return NO_SUGGESTION;

    return yield* textGeneration
      .generateNextPrompt({
        cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
        message: context.message,
        instructions: settings.nextPromptInstructions,
        modelSelection: settings.textGenerationModelSelection,
      })
      .pipe(
        // A missing hint is cheaper than an error toast on every reply.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Next prompt suggestion failed", {
                threadId: input.threadId,
                cause,
              }).pipe(Effect.as({ suggestion: null })),
        ),
      );
  });

  return NextPromptSuggestionService.of({ suggest });
});

export const layer = Layer.effect(NextPromptSuggestionService, make);
