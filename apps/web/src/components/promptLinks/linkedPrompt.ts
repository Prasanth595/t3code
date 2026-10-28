import type { LinkedPrompt } from "@t3tools/shared/promptLinks";

import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";

import { toastManager } from "../ui/toast";

export function warnAboutHiddenCharacters(prompt: LinkedPrompt): void {
  if (prompt.hiddenCharacters === 0) return;
  toastManager.add({
    type: "warning",
    title: "Promptul avea caractere ascunse, poate fi rău intenționat",
    description: `Mira a eliminat ${prompt.hiddenCharacters === 1 ? "un caracter ascuns" : `${prompt.hiddenCharacters} caractere ascunse`}. Citește promptul înainte să-l trimiți.`,
    timeout: 0,
  });
}

export function placeLinkedPrompt(
  target: ComposerThreadTarget,
  prompt: LinkedPrompt,
  notes: ReadonlyArray<string> = [],
): void {
  warnAboutHiddenCharacters(prompt);
  const place = () => {
    useComposerDraftStore.getState().setPrompt(target, prompt.text);
    toastManager.add({
      type: "info",
      title: "Prompt adăugat dintr-un link",
      description: ["Citește-l înainte să-l trimiți.", ...notes].join(" "),
    });
  };
  const existing = useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";
  if (existing.trim().length === 0 || existing === prompt.text) {
    place();
    return;
  }
  const id = toastManager.add({
    type: "info",
    title: "Promptul din link e gata",
    description: "Conversația are deja o ciornă. O înlocuiești cu promptul din link?",
    timeout: 0,
    actionProps: {
      children: "Înlocuiește ciorna",
      onClick: () => {
        toastManager.close(id);
        place();
      },
    },
  });
}
