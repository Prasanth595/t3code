import type { ThreadListV2Status } from "./threadListV2";

export function shouldRecedeThreadRow(input: {
  readonly status: ThreadListV2Status;
  readonly selected: boolean;
  /** An open async question keeps the row at full emphasis while its run works. */
  readonly hasAsyncQuestion?: boolean;
}): boolean {
  return (
    !input.selected &&
    input.hasAsyncQuestion !== true &&
    (input.status === "working" || input.status === "waiting")
  );
}

/** Whether the row shows the Input marker for an async question its run keeps working through. */
export function hasThreadRowAsyncQuestion(input: {
  readonly status: ThreadListV2Status;
  readonly hasPendingAsyncQuestion?: boolean | undefined;
}): boolean {
  return input.status === "working" && input.hasPendingAsyncQuestion === true;
}

/** Beside Input the spinner and timer already say Working; any other label, such as Goal, stays. */
export function threadRowStatusText(input: {
  readonly hasAsyncQuestion: boolean;
  readonly label: string;
}): string | null {
  return input.hasAsyncQuestion && input.label === "Working" ? null : input.label;
}

export function threadRowAccessibilityLabel(input: {
  readonly title: string;
  readonly hasAsyncQuestion: boolean;
  readonly statusLabel: string | null;
  readonly hasQueuedMessages: boolean;
}): string {
  const statusText =
    input.statusLabel === null
      ? null
      : threadRowStatusText({ hasAsyncQuestion: input.hasAsyncQuestion, label: input.statusLabel });
  return [
    input.title,
    input.hasAsyncQuestion ? `Input, ${statusText ?? "still working"}` : null,
    input.hasQueuedMessages ? "messages queued to send" : null,
  ]
    .filter(Boolean)
    .join(", ");
}
