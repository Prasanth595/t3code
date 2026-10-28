import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { toastManager } from "../components/ui/toast";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useUiStateStore } from "../uiStateStore";

export function setThreadHiddenOnClient(threadRef: ScopedThreadRef, hidden: boolean): void {
  const threadKey = scopedThreadKey(threadRef);
  const state = useUiStateStore.getState();
  if (state.hiddenThreadKeys.includes(threadKey) === hidden) return;
  state.setThreadHidden(threadKey, hidden);
  const selection = useThreadSelectionStore.getState();
  if (hidden) selection.removeFromSelection([threadKey]);
  if (!hidden) return;
  const id = toastManager.add({
    type: "info",
    title: "Thread hidden on this device",
    description: "It stays visible on your other devices. Use Show hidden threads to restore it.",
    actionProps: {
      children: "Undo",
      onClick: () => {
        useUiStateStore.getState().setThreadHidden(threadKey, false);
        toastManager.close(id);
      },
    },
  });
}
