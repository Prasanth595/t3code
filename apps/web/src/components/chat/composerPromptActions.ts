import { type ComposerPromptAction, DEFAULT_COMPOSER_PROMPT_ACTIONS } from "@t3tools/contracts";

export function runnableComposerPromptActions(
  actions: ReadonlyArray<ComposerPromptAction>,
): ReadonlyArray<ComposerPromptAction> {
  return actions.filter((action) => action.label.trim() !== "" && action.prompt.trim() !== "");
}

/**
 * Adds the action's text as its own paragraph at the end of the draft. Running the same action
 * twice in a row leaves the draft unchanged, so a double click does not repeat the instruction.
 */
export function appendComposerPromptAction(prompt: string, actionPrompt: string): string {
  const addition = actionPrompt.trim();
  const draft = prompt.trimEnd();
  if (addition === "" || draft.endsWith(addition)) return prompt;
  return draft === "" ? addition : `${draft}\n\n${addition}`;
}

export function composerPromptActionsAreDefault(
  actions: ReadonlyArray<ComposerPromptAction>,
): boolean {
  return (
    actions.length === DEFAULT_COMPOSER_PROMPT_ACTIONS.length &&
    actions.every((action, index) => {
      const fallback = DEFAULT_COMPOSER_PROMPT_ACTIONS[index]!;
      return (
        action.id === fallback.id &&
        action.label === fallback.label &&
        action.prompt === fallback.prompt
      );
    })
  );
}
