import { useEffect, useRef, useState } from "react";
import type { AlertButton } from "react-native";

import { type DialogRequest, registerDialogPresenter, resolveAlertDismissal } from "../lib/alert";
import { MaterialConfirmDialog } from "./MaterialConfirmDialog";

type QueuedDialog = { readonly id: number; readonly request: DialogRequest };

let nextDialogId = 0;

/**
 * Renders showAlert and showTextInputDialog requests as Material dialogs on
 * Android, one at a time in the order they arrive. Mount once at the app root.
 */
export function ConfirmDialogHost() {
  const [queue, setQueue] = useState<readonly QueuedDialog[]>([]);
  // The dialog lingers until the next render, so a double tap must not run a button twice.
  const closedId = useRef<number | null>(null);
  useEffect(
    () =>
      registerDialogPresenter((request) => {
        const id = nextDialogId++;
        setQueue((current) => [...current, { id, request }]);
      }),
    [],
  );

  const presented = queue[0];
  if (presented === undefined) return null;
  const { request } = presented;
  const close = (then?: () => void) => {
    if (closedId.current === presented.id) return;
    closedId.current = presented.id;
    setQueue((current) => current.filter((dialog) => dialog.id !== presented.id));
    then?.();
  };

  if (request.kind === "text-input") {
    return (
      <MaterialConfirmDialog
        key={presented.id}
        title={request.title}
        inputInitialValue={request.initialValue}
        buttons={[
          { text: request.cancelText ?? "Cancel", onPress: () => close(request.onCancel) },
          { text: request.confirmText, onPress: (value) => close(() => request.onConfirm(value)) },
        ]}
        onDismiss={() => close(request.onCancel)}
      />
    );
  }

  const press = (button: AlertButton) => close(() => button.onPress?.());
  const dismissal = resolveAlertDismissal(request);
  return (
    <MaterialConfirmDialog
      key={presented.id}
      title={request.title}
      message={request.message}
      buttons={request.buttons.map((button) => ({
        text: button.text ?? "",
        destructive: button.style === "destructive",
        onPress: () => press(button),
      }))}
      onDismiss={() => {
        if (dismissal.kind === "dismiss") close(request.options?.onDismiss);
        else if (dismissal.kind === "press") press(dismissal.button);
      }}
    />
  );
}
