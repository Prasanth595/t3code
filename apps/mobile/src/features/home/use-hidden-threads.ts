import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { updateHiddenThreadKeys } from "./hidden-threads";
import { showLocalThreadUndoNotice } from "./thread-undo-notice";

const showHiddenThreadsAtom = Atom.make(false).pipe(Atom.keepAlive);
const hiddenThreadKeysAtom = Atom.make((get) => {
  const result = get(mobilePreferencesAtom);
  return new Set(AsyncResult.isSuccess(result) ? (result.value.hiddenThreadKeys ?? []) : []);
}).pipe(Atom.keepAlive);

export function useHiddenThreads() {
  const hiddenThreadKeys = useAtomValue(hiddenThreadKeysAtom);
  const [showHidden, setShowHidden] = useAtom(showHiddenThreadsAtom);
  return { hiddenThreadKeys, showHidden, setShowHidden };
}

export function useSetThreadHidden() {
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  return useCallback(
    async function setHidden(thread: EnvironmentThreadShell, hidden: boolean): Promise<void> {
      try {
        await updatePreferences({
          transform: (current) => ({
            hiddenThreadKeys: updateHiddenThreadKeys(
              current.hiddenThreadKeys ?? [],
              thread,
              hidden,
            ),
          }),
        });
        if (hidden) showLocalThreadUndoNotice(() => setHidden(thread, false));
      } catch {
        Dialog.alert(
          hidden ? "Could not hide thread" : "Could not restore thread",
          "Your device could not save this change. Please try again.",
        );
      }
    },
    [updatePreferences],
  );
}
