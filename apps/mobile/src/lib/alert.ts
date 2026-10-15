import { Alert, type AlertButton, type AlertOptions } from "react-native";

export type AlertDialogRequest = {
  readonly title: string;
  readonly message?: string;
  readonly buttons: readonly AlertButton[];
  readonly options?: AlertOptions;
};

export type TextInputDialogRequest = {
  readonly title: string;
  readonly initialValue: string;
  readonly cancelText?: string;
  readonly confirmText: string;
  readonly onConfirm: (value: string) => void;
  readonly onCancel?: () => void;
};

export type DialogRequest =
  | ({ readonly kind: "alert" } & AlertDialogRequest)
  | ({ readonly kind: "text-input" } & TextInputDialogRequest);

let presentDialog: ((request: DialogRequest) => void) | null = null;

/** Called by ConfirmDialogHost while it is mounted. Returns the unregister function. */
export function registerDialogPresenter(present: (request: DialogRequest) => void): () => void {
  presentDialog = present;
  return () => {
    if (presentDialog === present) presentDialog = null;
  };
}

/**
 * Drop-in for Alert.alert. Android's native alert takes its colors from
 * resources fixed at build time, so it ignores the user's theme; there the
 * alert renders as a Material dialog with the live palette instead. iOS keeps
 * the native alert, which already follows the system appearance.
 */
export function showAlert(
  title: string,
  message?: string,
  buttons?: readonly AlertButton[],
  options?: AlertOptions,
): void {
  if (process.env.EXPO_OS === "android" && presentDialog) {
    presentDialog({
      kind: "alert",
      title,
      ...(message ? { message } : {}),
      buttons: buttons?.length ? buttons : [{ text: "OK" }],
      ...(options ? { options } : {}),
    });
    return;
  }
  Alert.alert(title, message, buttons ? [...buttons] : undefined, options);
}

/** Android text prompt. iOS uses Alert.prompt instead. */
export function showTextInputDialog(request: TextInputDialogRequest): void {
  presentDialog?.({ kind: "text-input", ...request });
}

/**
 * What back or a tap outside the dialog does. Like the native alert, the
 * dialog stays open unless it is cancelable, except that an alert with a
 * cancel button, or only one button, treats dismissal as pressing it.
 */
export function resolveAlertDismissal(
  request: AlertDialogRequest,
):
  | { readonly kind: "ignore" }
  | { readonly kind: "dismiss" }
  | { readonly kind: "press"; readonly button: AlertButton } {
  if (request.options?.cancelable === true) return { kind: "dismiss" };
  if (request.options?.cancelable === false) return { kind: "ignore" };
  const button =
    request.buttons.find((candidate) => candidate.style === "cancel") ??
    (request.buttons.length === 1 ? request.buttons[0] : undefined);
  return button ? { kind: "press", button } : { kind: "ignore" };
}
