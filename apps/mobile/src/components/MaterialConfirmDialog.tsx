export interface MaterialDialogButton {
  readonly text: string;
  readonly destructive?: boolean;
  /** Receives the text field's value when the dialog has one. */
  readonly onPress: (inputValue: string) => void;
}

export interface MaterialConfirmDialogProps {
  readonly title: string;
  readonly message?: string | undefined;
  /** Laid out start to end; the last one is the confirming action. */
  readonly buttons: readonly MaterialDialogButton[];
  /** Shows a text field; the confirming button is disabled while it is blank. */
  readonly inputInitialValue?: string;
  /** Back or a tap outside the dialog. */
  readonly onDismiss: () => void;
}

export function MaterialConfirmDialog(_props: MaterialConfirmDialogProps) {
  return null;
}
