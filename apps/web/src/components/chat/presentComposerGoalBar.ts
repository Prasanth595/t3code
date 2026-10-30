import { parseGoalCommand, type OrchestrationV2ProviderGoal } from "@t3tools/contracts";
import { presentProviderGoal } from "@t3tools/client-runtime/state/thread-execution";

/** A `/goal` command filling the composer, when the whole draft is that command. */
type ComposerGoalCommandIntent = "show" | "clear" | "pause" | "resume" | "set";

function composerGoalCommandIntent(input: {
  readonly prompt: string;
  readonly hasAttachments: boolean;
}): ComposerGoalCommandIntent | null {
  // Attachments make the message an ordinary prompt, matching parseGoalCommand.
  if (input.hasAttachments) return null;
  return parseGoalCommand({ text: input.prompt })?.type ?? null;
}

/** Pause an active goal, or play a goal that is waiting. Codex only; Claude has neither. */
export type ComposerGoalPlayback = "pause" | "play";

export interface ComposerGoalBarModel {
  readonly title: string;
  /** The goal this command applies to, or the goal currently set. */
  readonly objective: string;
  readonly usage: string | null;
  /**
   * The pause/play control. It follows the goal's status, not the draft: an active
   * goal pauses, and any other open goal plays, whether it was set with `/goal resume`
   * or `/goal` plus an objective.
   */
  readonly playback: ComposerGoalPlayback | null;
  /** The draft is a goal command, so the bar names that action instead of the resting status. */
  readonly emphasizing: "resume" | "pause" | "clear" | "replace" | null;
}

/**
 * The line above the composer. A finished goal leaves the field. Typing `/goal resume`
 * (or pause, clear, or a new objective) names the goal that command will change.
 */
export function presentComposerGoalBar(input: {
  readonly goal: OrchestrationV2ProviderGoal | null;
  readonly working: boolean;
  readonly prompt: string;
  /** Codex can pause and resume. Claude rejects those commands. */
  readonly canPauseResume: boolean;
  /** The draft includes an image or file, so `/goal` is sent as an ordinary prompt. */
  readonly hasAttachments?: boolean;
}): ComposerGoalBarModel | null {
  const { goal } = input;
  if (goal === null || goal.status === "complete") return null;
  const presentation = presentProviderGoal(goal, input.working);
  const parsed = composerGoalCommandIntent({
    prompt: input.prompt,
    hasAttachments: input.hasAttachments === true,
  });
  // Claude rejects pause and resume; do not label a draft the server will refuse.
  const intent =
    !input.canPauseResume && (parsed === "pause" || parsed === "resume") ? null : parsed;
  const resting = {
    objective: presentation.objective,
    usage: presentation.usage,
    // Play resumes a waiting goal. Hide it while the thread is working so it does not
    // stop unrelated work. Pause stays available on an active goal.
    playback: !input.canPauseResume
      ? null
      : goal.status === "active"
        ? "pause"
        : input.working
          ? null
          : "play",
  } as const;
  switch (intent) {
    case "resume":
      return { ...resting, title: "Resuming goal", emphasizing: "resume" };
    case "pause":
      return { ...resting, title: "Pausing goal", emphasizing: "pause" };
    case "clear":
      return { ...resting, title: "Clearing goal", emphasizing: "clear" };
    case "set":
      return { ...resting, title: "Replacing goal", emphasizing: "replace" };
    case "show":
    case null:
      return { ...resting, title: presentation.title, emphasizing: null };
  }
}
