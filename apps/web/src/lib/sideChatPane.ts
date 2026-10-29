import type { ToolCallDiffTarget } from "../diffPanelStore";

/** Whether an event started in the side chat pane (`data-side-chat-pane`), which the main chat ignores. */
export function isInSideChatPane(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-side-chat-pane]") !== null;
}

/**
 * Opens an embedded side chat's tool diffs in its parent's diff panel. Other panel actions reach
 * the parent through `hostRightPanel`; diff selection lives in `diffPanelStore`, which it skips.
 */
export interface SideChatParentPanel {
  readonly openToolDiff: (target: ToolCallDiffTarget) => void;
}
