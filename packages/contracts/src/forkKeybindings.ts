/**
 * Fork: keybinding commands for focus levels, the sidebar and timeline cursors, thread actions
 * and approvals. `keybindings.ts` spreads them into the upstream command list.
 */

export const SIDEBAR_GROUP_JUMP_KEYBINDING_COMMANDS = [
  "sidebar.group.1",
  "sidebar.group.2",
  "sidebar.group.3",
  "sidebar.group.4",
  "sidebar.group.5",
  "sidebar.group.6",
  "sidebar.group.7",
  "sidebar.group.8",
  "sidebar.group.9",
] as const;
export type SidebarGroupJumpKeybindingCommand =
  (typeof SIDEBAR_GROUP_JUMP_KEYBINDING_COMMANDS)[number];

export const FORK_KEYBINDING_COMMANDS = [
  "focus.up",
  "focus.left",
  "focus.right",
  "focus.composer",
  "focus.timeline",
  "focus.sidebar",
  "focus.rightPanel",
  "sidebar.previousItem",
  "sidebar.nextItem",
  "sidebar.openItem",
  "sidebar.previousGroup",
  "sidebar.nextGroup",
  "sidebar.search",
  ...SIDEBAR_GROUP_JUMP_KEYBINDING_COMMANDS,
  "timeline.previous",
  "timeline.next",
  "timeline.deeper",
  "timeline.shallower",
  "timeline.extendUp",
  "timeline.extendDown",
  "timeline.cite",
  "timeline.citeWithNote",
  "timeline.jumpToLatest",
  "thread.archive",
  "thread.snooze",
  "thread.rename",
  "thread.markUnread",
  "approval.approve",
  "approval.alwaysAllow",
  "approval.decline",
  "rightPanel.previousTab",
  "rightPanel.nextTab",
  "settings.open",
] as const;
export type ForkKeybindingCommand = (typeof FORK_KEYBINDING_COMMANDS)[number];
