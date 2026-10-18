import { type KeybindingRule, SIDEBAR_GROUP_JUMP_KEYBINDING_COMMANDS } from "@t3tools/contracts";

const SIDEBAR_KEYS = "sidebarFocus && !editableFocus";
const TIMELINE_KEYS = "timelineFocus && !editableFocus";
// `mod+y` is redo in editors, and Ctrl+Y pastes in shells. An approval cannot be undone.
const APPROVAL_KEYS = "approvalPending && !editableFocus && !terminalFocus";
// Browsers keep these keys for their own tabs, and a terminal must still receive them.
const DESKTOP_KEYS = "isDesktop && !terminalFocus";

/**
 * Fork: defaults for the focus level commands. `keybindings.ts` appends them after the upstream
 * defaults, so a rule here wins over an upstream rule for the same key, such as `mod+f` in the
 * sidebar.
 */
export const FORK_DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  {
    key: "escape",
    command: "focus.up",
    when: "composerFocus || ((timelineFocus || rightPanelFocus) && !editableFocus)",
  },
  { key: "mod+alt+arrowleft", command: "focus.left", when: DESKTOP_KEYS },
  { key: "mod+alt+arrowright", command: "focus.right", when: DESKTOP_KEYS },
  { key: "arrowup", command: "sidebar.previousItem", when: SIDEBAR_KEYS },
  { key: "arrowdown", command: "sidebar.nextItem", when: SIDEBAR_KEYS },
  { key: "enter", command: "sidebar.openItem", when: SIDEBAR_KEYS },
  { key: "arrowleft", command: "sidebar.previousGroup", when: SIDEBAR_KEYS },
  { key: "arrowright", command: "sidebar.nextGroup", when: SIDEBAR_KEYS },
  { key: "mod+alt+[", command: "sidebar.previousGroup", when: "!terminalFocus" },
  { key: "mod+alt+]", command: "sidebar.nextGroup", when: "!terminalFocus" },
  { key: "mod+f", command: "sidebar.search", when: "sidebarFocus" },
  ...SIDEBAR_GROUP_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    key: `${index + 1}`,
    command,
    when: SIDEBAR_KEYS,
  })),
  { key: "arrowup", command: "timeline.previous", when: TIMELINE_KEYS },
  { key: "arrowdown", command: "timeline.next", when: TIMELINE_KEYS },
  { key: "arrowright", command: "timeline.deeper", when: TIMELINE_KEYS },
  { key: "arrowleft", command: "timeline.shallower", when: TIMELINE_KEYS },
  { key: "shift+arrowup", command: "timeline.extendUp", when: TIMELINE_KEYS },
  { key: "shift+arrowdown", command: "timeline.extendDown", when: TIMELINE_KEYS },
  { key: "enter", command: "timeline.citeWithNote", when: TIMELINE_KEYS },
  { key: "alt+enter", command: "timeline.cite", when: TIMELINE_KEYS },
  { key: "mod+arrowdown", command: "timeline.jumpToLatest", when: TIMELINE_KEYS },
  {
    key: "mod+backspace",
    command: "thread.archive",
    when: "(sidebarFocus || timelineFocus) && !editableFocus",
  },
  { key: "mod+.", command: "thread.stop", when: "!terminalFocus" },
  { key: "mod+alt+s", command: "thread.snooze", when: "!terminalFocus" },
  { key: "mod+alt+r", command: "thread.rename", when: "!terminalFocus" },
  { key: "mod+shift+u", command: "thread.markUnread", when: "!terminalFocus" },
  { key: "mod+y", command: "approval.approve", when: APPROVAL_KEYS },
  { key: "mod+shift+y", command: "approval.alwaysAllow", when: APPROVAL_KEYS },
  { key: "mod+alt+y", command: "approval.decline", when: APPROVAL_KEYS },
  { key: "ctrl+shift+tab", command: "rightPanel.previousTab", when: DESKTOP_KEYS },
  { key: "ctrl+tab", command: "rightPanel.nextTab", when: DESKTOP_KEYS },
  { key: "mod+,", command: "settings.open", when: "isWeb" },
  // Ctrl+/ is undo in shells, so the terminal keeps it.
  { key: "mod+/", command: "keyboard.cheatSheet", when: "!terminalFocus" },
];
