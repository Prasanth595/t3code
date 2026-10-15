import { buildNewThreadLink, type LinkedPrompt } from "@t3tools/shared/promptLinks";
import { Alert } from "react-native";

import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import {
  getComposerDraftSnapshot,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { linkedThreadDraftAction } from "./prompt-link-model";

export function showPromptLinkNotice(notice: string): void {
  Alert.alert("Prompt from a link", notice);
}

export async function applyLinkedPromptToThreadDraft(
  draftKey: string,
  prompt: LinkedPrompt,
  notice: string,
): Promise<void> {
  try {
    await waitForComposerDraftsLoaded();
  } catch {
    Alert.alert("Could not open link", "Drafts could not be loaded, so the prompt was not added.");
    return;
  }
  const action = linkedThreadDraftAction(getComposerDraftSnapshot(draftKey).text, prompt.text);
  if (action !== "ask") {
    if (action === "fill") setComposerDraftText(draftKey, prompt.text);
    showPromptLinkNotice(notice);
    return;
  }
  Alert.alert("Linked prompt ready. Replace draft?", notice, [
    { text: "Keep mine", style: "cancel" },
    { text: "Replace", onPress: () => setComposerDraftText(draftKey, prompt.text) },
  ]);
}

export async function copyPromptLink(prompt: string): Promise<void> {
  if (!(await tryCopyTextWithHaptic(buildNewThreadLink({ prompt }), { target: "prompt link" }))) {
    Alert.alert("Could not copy", "Try again.");
  }
}
