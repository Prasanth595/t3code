import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";

import { undoLatestThreadAction, useThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { shortcutLabelForCommand } from "../../keybindings";
import { announce, cancelAnnouncement } from "../../lib/announce";
import { cn } from "../../lib/utils";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { InlineButton } from "../ui/button";

export function SidebarThreadUndoNotice({ className }: { className?: string }) {
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

  // Keeps the last text on screen while it fades out, then unmounts on transitionend.
  const [shownSummary, setShownSummary] = useState(summary);
  if (summary && summary !== shownSummary) setShownSummary(summary);
  const text = summary ?? shownSummary;
  if (!text) return null;

  return (
    <div
      role="group"
      aria-hidden={!summary}
      inert={!summary}
      onTransitionEnd={(event) => {
        if (!summary && event.target === event.currentTarget) setShownSummary(null);
      }}
      className={cn(
        "truncate px-2 text-2xs leading-6 text-sidebar-muted-foreground transition-opacity duration-200 ease-out starting:opacity-0",
        !summary && "opacity-0",
        className,
      )}
    >
      {text}, <InlineButton onClick={undoLatestThreadAction}>{undoLabel}</InlineButton>
    </div>
  );
}
