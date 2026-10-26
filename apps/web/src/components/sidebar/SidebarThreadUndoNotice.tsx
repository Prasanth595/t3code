import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { undoLatestThreadAction, useThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { shortcutLabelForCommand } from "../../keybindings";
import { announce, cancelAnnouncement } from "../../lib/announce";
import { cn } from "../../lib/utils";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { InlineButton } from "../ui/button";

export function SidebarThreadUndoNotice({ onBackdrop }: { onBackdrop: boolean }) {
  const notice = useThreadUndoNotice((state) => state.notice);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  const shortcut = shortcutLabelForCommand(keybindings, "thread.undo");
  const undoLabel = shortcut ? `${shortcut} to undo` : "Undo";
  const summary = notice
    ? `${notice.action} ${notice.count} ${notice.action === "Discarded" ? "draft" : "thread"}${notice.count === 1 ? "" : "s"}`
    : null;

  // A live region that mounts already filled is skipped by screen readers, and settling
  // usually moves focus to the next thread at the same moment.
  useEffect(() => {
    if (summary) announce(`${summary}, ${undoLabel}`, "thread-undo-notice");
    else cancelAnnouncement("thread-undo-notice");
  }, [summary, undoLabel]);

  if (!summary) return null;

  return (
    <div
      role="group"
      className={cn(
        "ml-[var(--workspace-titlebar-content-left)] min-w-0 truncate text-2xs leading-7",
        onBackdrop ? "text-white/70" : "text-sidebar-muted-foreground",
      )}
    >
      {summary},{" "}
      <InlineButton onClick={undoLatestThreadAction} tone="inherit">
        {undoLabel}
      </InlineButton>
    </div>
  );
}
