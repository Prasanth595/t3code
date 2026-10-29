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
  )(
    function* (input) {
      const records = yield* threads.getThreadRecords(input.threadId, ["messages", "runs"], {
        messageRoles: ["user", "assistant"],
      });
      const context = formatThreadTitleContext(
        records.messages.filter((message) => !message.streaming),
      );
      const project = yield* projects.get(records.thread.projectId);
      if (context.message.length === 0 || Option.isNone(project)) return { prompts: [] };
      const latestRun = records.runs
        .filter((run) => run.status !== "rolled_back")
        .reduce<(typeof records.runs)[number] | undefined>(
          (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
          undefined,
        );
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        records.thread.projectId,
      ).settings;
      const result = yield* textGeneration.generateNextPrompts({
        cwd: records.thread.worktreePath ?? project.value.workspaceRoot,
        title: records.thread.title,
        conversation: context.message,
        failed: latestRun?.status === "failed",
        modelSelection: settings.textGenerationModelSelection,
      });
      return { prompts: result.prompts };
    },
    (effect, input) =>
      Effect.mapError(
        effect,
        (cause) => new OrchestrationV2SuggestNextPromptsError({ threadId: input.threadId, cause }),
      ),
  );

  return NextPromptSuggestionService.of({ suggest });
});

export const layer = Layer.effect(NextPromptSuggestionService, make);
