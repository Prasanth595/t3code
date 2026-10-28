import { isTemporaryThread } from "@t3tools/client-runtime/temporary-threads";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore, type ComposerThreadTarget } from "./composerDraftStore";

export function isTemporaryComposerTarget(target: ComposerThreadTarget): boolean {
  const draft = useComposerDraftStore.getState().getDraftThread(target);
  if (draft)
    return draft.temporary === true || isTemporaryThread(draft.environmentId, draft.threadId);
  return typeof target !== "string" && isTemporaryThread(target.environmentId, target.threadId);
}

export function isTemporaryThreadKey(key: string): boolean {
  const draft = useComposerDraftStore.getState().draftThreadsByThreadKey[key];
  if (draft)
    return draft.temporary === true || isTemporaryThread(draft.environmentId, draft.threadId);
  const ref = parseScopedThreadKey(key);
  return ref !== null && isTemporaryThread(ref.environmentId, ref.threadId);
}

export function persistentThreadEntries<T>(entries: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(entries).filter(([key]) => !isTemporaryThreadKey(key)));
}
