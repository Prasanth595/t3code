import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import {
  type ComposerThreadTarget,
  composerDraftHasUserContent,
  resolveComposerDraftKey,
  useComposerDraftStore,
} from "../composerDraftStore";
import { showThreadUndoNotice } from "../hooks/showThreadUndoNotice";
import * as ThreadUndo from "../hooks/threadUndo";
import { releaseDraftAttachments } from "./attachmentUploadQueue";

export function discardComposerDraft(target: ComposerThreadTarget): void {
  const store = useComposerDraftStore.getState();
  const key = resolveComposerDraftKey(store, target);
  if (key === null) return;
  const draft = store.draftsByThreadKey[key];
  const session = store.draftThreadsByThreadKey[key];
  const discardsSession = typeof target === "string";
  if (!draft && !(discardsSession && session)) return;
  const logicalProjectKeys = Object.entries(store.logicalProjectDraftThreadKeyByLogicalProjectKey)
    .filter(([, draftKey]) => draftKey === key)
    .map(([logicalProjectKey]) => logicalProjectKey);

  const claim = ThreadUndo.begin("discard", key);
  if (discardsSession) {
    store.clearDraftThread(target);
  } else {
    store.clearComposerContent(target);
  }

  showThreadUndoNotice({
    action: "Discarded",
    claim,
    failureTitle: "Failed to restore draft",
    undo: async () => {
      const current = useComposerDraftStore.getState().draftsByThreadKey[key];
      if (current && composerDraftHasUserContent(current)) {
        if (draft) releaseDraftAttachments([...draft.images, ...draft.files]);
        return AsyncResult.failure(Cause.fail(new Error("The draft has new content.")));
      }
      useComposerDraftStore.setState((state) => {
        const logicalProjectDraftThreadKeyByLogicalProjectKey = {
          ...state.logicalProjectDraftThreadKeyByLogicalProjectKey,
        };
        for (const logicalProjectKey of logicalProjectKeys) {
          logicalProjectDraftThreadKeyByLogicalProjectKey[logicalProjectKey] ??= key;
        }
        return {
          draftsByThreadKey: !draft
            ? state.draftsByThreadKey
            : {
                ...state.draftsByThreadKey,
                [key]: discardsSession
                  ? {
                      ...draft,
                      images: draft.images.map((image) =>
                        image.previewUrl.startsWith("blob:")
                          ? { ...image, previewUrl: URL.createObjectURL(image.file) }
                          : image,
                      ),
                    }
                  : draft,
              },
          draftThreadsByThreadKey: session
            ? { ...state.draftThreadsByThreadKey, [key]: session }
            : state.draftThreadsByThreadKey,
          logicalProjectDraftThreadKeyByLogicalProjectKey,
        };
      });
      return AsyncResult.success(undefined);
    },
    commit: () => {
      if (draft) releaseDraftAttachments([...draft.images, ...draft.files]);
    },
  });
}
