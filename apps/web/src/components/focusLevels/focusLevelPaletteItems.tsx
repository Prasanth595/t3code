import type { ForkKeybindingCommand } from "@t3tools/contracts";
import {
  ArchiveIcon,
  ClockIcon,
  type LucideIcon,
  MailOpenIcon,
  MessageSquareTextIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PencilIcon,
  TextCursorInputIcon,
} from "lucide-react";
import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import { type FocusLevel, focusLevel } from "./focusLevels";
import { runRegisteredFocusLevelCommand } from "./useFocusLevelShortcuts";

const FOCUS_ITEMS: ReadonlyArray<[ForkKeybindingCommand, FocusLevel, string, LucideIcon]> = [
  ["focus.composer", "composer", "Focus composer", TextCursorInputIcon],
  ["focus.timeline", "timeline", "Focus timeline", MessageSquareTextIcon],
  ["focus.sidebar", "sidebar", "Focus sidebar", PanelLeftIcon],
  ["focus.rightPanel", "rightPanel", "Focus right panel", PanelRightIcon],
];

const THREAD_ITEMS: ReadonlyArray<[ForkKeybindingCommand, string, LucideIcon]> = [
  ["thread.archive", "Archive thread", ArchiveIcon],
  ["thread.snooze", "Snooze or wake thread", ClockIcon],
  ["thread.rename", "Rename thread", PencilIcon],
  ["thread.markUnread", "Mark thread unread", MailOpenIcon],
];

/** The palette restores focus as it closes, so a focus move waits until that is done. */
function afterPaletteCloses(run: () => void): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        run();
        resolve();
      }),
    ),
  );
}

/** Fork: command palette items for the focus level commands. */
export function focusLevelPaletteItems(iconClassName: string): CommandPaletteActionItem[] {
  return [
    ...FOCUS_ITEMS.map(([command, level, title, Icon]) => ({
      kind: "action" as const,
      value: `action:${command}`,
      searchTerms: ["focus", "keyboard", "move", title],
      title,
      icon: <Icon className={iconClassName} />,
      shortcutCommand: command,
      run: () => afterPaletteCloses(() => void focusLevel(level)),
    })),
    ...THREAD_ITEMS.map(([command, title, Icon]) => ({
      kind: "action" as const,
      value: `action:${command}`,
      searchTerms: ["thread", title],
      title,
      icon: <Icon className={iconClassName} />,
      shortcutCommand: command,
      run: () => afterPaletteCloses(() => void runRegisteredFocusLevelCommand(command)),
    })),
  ];
}
