import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { ModelSelection, ScopedThreadRef } from "@t3tools/contracts";

import { type ComposerThreadDraftState, useComposerDraftStore } from "../composerDraftStore";

/** Accepted turns own their model; only a newer unsent choice stays in the composer. */
export async function startTurnWithComposerModel<A, E>(
  threadRef: ScopedThreadRef,
  modelSelection: ModelSelection | undefined,
  start: () => Promise<AtomCommandResult<A, E>>,
  draft: ComposerThreadDraftState | null = useComposerDraftStore
    .getState()
    .getComposerDraft(threadRef),
): Promise<AtomCommandResult<A, E>> {
  const selection = draft?.activeProvider
    ? draft.modelSelectionByProvider[draft.activeProvider]
    : undefined;
  const result = await start();
  if (
    result._tag === "Success" &&
    draft &&
    selection &&
    selection.instanceId === modelSelection?.instanceId &&
    selection.model === modelSelection.model
  ) {
    useComposerDraftStore.getState().confirmModelSelection(threadRef, draft);
  }
  return result;
}
