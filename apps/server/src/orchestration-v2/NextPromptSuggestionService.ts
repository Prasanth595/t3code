import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  OrchestrationV2SuggestNextPromptsError,
  type OrchestrationV2SuggestNextPromptsInput,
  type OrchestrationV2SuggestNextPromptsResult,
} from "@t3tools/contracts";
import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const MAX_FAILURE_CHARS = 1_000;

const failAt =
  (
    threadId: OrchestrationV2SuggestNextPromptsInput["threadId"],
    stage: OrchestrationV2SuggestNextPromptsError["stage"],
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.mapError(
      effect,
      (cause) => new OrchestrationV2SuggestNextPromptsError({ threadId, stage, cause }),
    );

export class NextPromptSuggestionService extends Context.Service<
  NextPromptSuggestionService,
  {
    readonly suggest: (
      input: OrchestrationV2SuggestNextPromptsInput,
    ) => Effect.Effect<
      OrchestrationV2SuggestNextPromptsResult,
      OrchestrationV2SuggestNextPromptsError
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
    const records = yield* threads
      .getThreadRecords(input.threadId, ["messages", "runs"], {
        messageRoles: ["user", "assistant"],
      })
      .pipe(failAt(input.threadId, "load-thread"));
    const rolledBack = records.runs.filter((run) => run.status === "rolled_back");
    const rolledBackRunIds = new Set(rolledBack.map((run) => run.id));
    const rolledBackMessageIds = new Set(rolledBack.map((run) => run.userMessageId));
    const context = formatThreadTitleContext(
      records.messages.filter(
        (message) =>
          !message.streaming &&
          !rolledBackMessageIds.has(message.id) &&
          (message.runId === null || !rolledBackRunIds.has(message.runId)),
      ),
    );
    const project = yield* projects
      .get(records.thread.projectId)
      .pipe(failAt(input.threadId, "load-project"));
    if (context.message.length === 0 || Option.isNone(project)) return { prompts: [] };
    const latestRun = records.runs
      .filter((run) => run.status !== "rolled_back")
      .reduce<(typeof records.runs)[number] | undefined>(
        (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
        undefined,
      );
    const failed = latestRun?.status === "failed";
    const failure = failed
      ? (yield* threads
          .getThreadRecords(input.threadId, ["turnItems"], {
            turnItemRunId: latestRun.id,
            turnItemTypes: ["error"],
          })
          .pipe(failAt(input.threadId, "load-thread"))).turnItems.findLast(
          (item) => item.type === "error",
        )
      : undefined;
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings.pipe(failAt(input.threadId, "load-settings")),
      records.thread.projectId,
    ).settings;
    const result = yield* textGeneration
      .generateNextPrompts({
        cwd: records.thread.worktreePath ?? project.value.workspaceRoot,
        title: records.thread.title,
        conversation: context.message,
        failed,
        ...(failure?.type === "error"
          ? { failureMessage: failure.failure.message.slice(0, MAX_FAILURE_CHARS) }
          : {}),
        modelSelection: settings.textGenerationModelSelection,
      })
      .pipe(failAt(input.threadId, "generate"));
    return { prompts: result.prompts };
  });

  return NextPromptSuggestionService.of({ suggest });
});

export const layer = Layer.effect(NextPromptSuggestionService, make);
