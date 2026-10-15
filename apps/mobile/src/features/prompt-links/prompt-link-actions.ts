import { buildNewThreadLink, type LinkedPrompt } from "@t3tools/shared/promptLinks";

import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import {
  getComposerDraftSnapshot,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { linkedThreadDraftAction } from "./prompt-link-model";
import { showAlert } from "../../lib/alert";

/** Shows the one notice a prompt link owes the user, built with `promptLinkNotice`. */
export function showPromptLinkNotice(notice: string): void {
  showAlert("Prompt from a link", notice);
}

/**
 * Puts a linked prompt into an existing thread's composer draft. An empty composer is filled;
 * typed text is replaced only when the user says so. The notice rides in the same alert, so a
 * link never stacks two dialogs.
 */
export async function applyLinkedPromptToThreadDraft(
  draftKey: string,
  prompt: LinkedPrompt,
  notice: string,
): Promise<void> {
  try {
    await waitForComposerDraftsLoaded();
  } catch {
    showAlert("Could not open link", "Drafts could not be loaded, so the prompt was not added.");
    return;
  }
  const action = linkedThreadDraftAction(getComposerDraftSnapshot(draftKey).text, prompt.text);
  if (action !== "ask") {
    if (action === "fill") setComposerDraftText(draftKey, prompt.text);
    showPromptLinkNotice(notice);
    return;
  }
  showAlert("Linked prompt ready. Replace draft?", notice, [
    { text: "Keep mine", style: "cancel" },
    { text: "Replace", onPress: () => setComposerDraftText(draftKey, prompt.text) },
  ]);
}

/** Copies a shareable link that opens a new task with this prompt. Used by sent user messages. */
export async function copyPromptLink(prompt: string): Promise<void> {
  if (!(await tryCopyTextWithHaptic(buildNewThreadLink({ prompt }), { target: "prompt link" }))) {
    showAlert("Could not copy", "Try again.");
  }
}
