import {
  type KeybindingCommand,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  type ResolvedKeybindingsConfig,
  SIDEBAR_GROUP_JUMP_KEYBINDING_COMMANDS,
  STATIC_KEYBINDING_COMMANDS,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";

import { effectiveShortcutsForCommand, formatShortcutLabel } from "../../keybindings";
import { commandLabel } from "../settings/KeybindingsSettings.logic";
import type { FocusLevel } from "./focusLevels";

export type CheatSheetAreaId =
  | "composer"
  | "timeline"
  | "sidebar"
  | "rightPanel"
  | "terminal"
  | "thread"
  | "focus"
  | "general";

export interface CheatSheetRow {
  readonly command: KeybindingCommand;
  readonly label: string;
  readonly keys: ReadonlyArray<string>;
}

export interface CheatSheetArea {
  readonly id: CheatSheetAreaId;
  readonly title: string;
  /** The focus levels area: its keys work only while `keyboardFocusLevels` is on. */
  readonly needsFocusLevels: boolean;
  readonly rows: ReadonlyArray<CheatSheetRow>;
}

const AREAS: ReadonlyArray<{
  readonly id: CheatSheetAreaId;
  readonly title: string;
  readonly context: Record<string, boolean>;
  readonly needsFocusLevels: boolean;
}> = [
  // Escape climbs from the composer, so the composer is where its key shows.
  { id: "focus", title: "Move focus", context: { composerFocus: true }, needsFocusLevels: true },
  {
    id: "composer",
    title: "Composer",
    context: { composerFocus: true, editableFocus: true },
    needsFocusLevels: false,
  },
  { id: "timeline", title: "Timeline", context: { timelineFocus: true }, needsFocusLevels: true },
  {
    id: "sidebar",
    title: "Sidebar and threads",
    context: { sidebarFocus: true },
    needsFocusLevels: false,
  },
  {
    id: "rightPanel",
    title: "Right panel and preview",
    context: { rightPanelFocus: true, rightPanelOpen: true, previewFocus: true, previewOpen: true },
    needsFocusLevels: false,
  },
  {
    id: "terminal",
    title: "Terminal",
    context: { terminalFocus: true, terminalOpen: true },
    needsFocusLevels: false,
  },
  { id: "thread", title: "Thread and approvals", context: {}, needsFocusLevels: false },
  { id: "general", title: "Everywhere", context: {}, needsFocusLevels: false },
];

/** The screen level that a cheat sheet opened from shows first. */
export const AREA_OF_LEVEL: Record<FocusLevel, CheatSheetAreaId> = {
  composer: "composer",
  timeline: "timeline",
  sidebar: "sidebar",
  rightPanel: "rightPanel",
};

function areaOf(command: KeybindingCommand): CheatSheetAreaId {
  const [prefix] = command.split(".");
  switch (prefix) {
    case "focus":
      return "focus";
    case "composer":
    case "modelPicker":
      return "composer";
    case "timeline":
      return "timeline";
    case "sidebar":
      return "sidebar";
    case "rightPanel":
    case "preview":
    case "diff":
    case "view":
      return "rightPanel";
    case "terminal":
      return "terminal";
    case "approval":
      return "thread";
    case "thread":
      return command === "thread.previous" ||
        command === "thread.next" ||
        command.startsWith("thread.jump.")
        ? "sidebar"
        : command === "thread.steerQueuedMessage" || command === "thread.editQueuedMessage"
          ? "composer"
          : "thread";
    default:
      return "general";
  }
}

/** Some rules also need a state that the area alone does not imply. */
const EXTRA_CONTEXT: Partial<Record<KeybindingCommand, Record<string, boolean>>> = {
  "composer.sendAlternate": { turnRunning: true },
  "composer.sendBackground": { draftThreadRoute: true },
  "approval.approve": { approvalPending: true },
  "approval.alwaysAllow": { approvalPending: true },
  "approval.decline": { approvalPending: true },
  "modelPicker.previousProvider": { modelPickerOpen: true },
  "modelPicker.nextProvider": { modelPickerOpen: true },
  "usage.cost": { usagePageOpen: true },
  "usage.tokens": { usagePageOpen: true },
  "usage.limits": { usagePageOpen: true },
  "usage.period.day": { usagePageOpen: true },
  "usage.period.week": { usagePageOpen: true },
  "usage.period.month": { usagePageOpen: true },
  "usage.period.quarter": { usagePageOpen: true },
};

/** Families of nine numbered commands show as one row, such as "Jump to thread 1–9". */
const FAMILIES: ReadonlyArray<{
  readonly commands: ReadonlyArray<KeybindingCommand>;
  readonly label: string;
  readonly context: Record<string, boolean>;
}> = [
  { commands: THREAD_JUMP_KEYBINDING_COMMANDS, label: "Jump to thread 1–9", context: {} },
  {
    commands: MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
    label: "Choose model 1–9",
    context: { modelPickerOpen: true },
  },
  {
    commands: SIDEBAR_GROUP_JUMP_KEYBINDING_COMMANDS,
    label: "Switch to group 1–9",
    context: { sidebarFocus: true },
  },
];
const FAMILY_MEMBERS: ReadonlySet<KeybindingCommand> = new Set(
  FAMILIES.flatMap((family) => family.commands),
);

/** Plain names for commands whose generated "Area: Verb" label repeats the heading or reads badly. */
const LABELS: Partial<Record<KeybindingCommand, string>> = {
  "focus.up": "Up one level",
  "focus.left": "Area to the left",
  "focus.right": "Area to the right",
  "focus.composer": "Composer",
  "focus.timeline": "Timeline",
  "focus.sidebar": "Sidebar",
  "focus.rightPanel": "Right panel",
  "timeline.previous": "Previous part",
  "timeline.next": "Next part",
  "timeline.deeper": "Go deeper",
  "timeline.shallower": "Go back up",
  "timeline.cite": "Cite without note",
  "timeline.citeWithNote": "Cite with note, or click the link or button",
  "timeline.jumpToLatest": "Jump to latest",
  "timeline.extendUp": "Extend selection up",
  "timeline.extendDown": "Extend selection down",
  "composer.stash": "Stash draft",
  "composer.host": "Choose host",
  "composer.effort": "Choose effort",
  "composer.mode": "Choose access mode",
  "composer.workspace": "Choose workspace",
  "composer.branch": "Choose branch",
  "modelPicker.toggle": "Choose model",
  "sidebar.toggle": "Toggle sidebar",
  "sidebar.search": "Search threads",
  "sidebar.previousItem": "Thread above",
  "sidebar.nextItem": "Thread below",
  "sidebar.openItem": "Open thread",
  "sidebar.previousGroup": "Previous group",
  "sidebar.nextGroup": "Next group",
  "thread.previous": "Previous thread",
  "thread.next": "Next thread",
  "rightPanel.toggle": "Toggle right panel",
  "rightPanel.new": "New tab",
  "rightPanel.close": "Close tab",
  "diff.toggle": "Toggle diff",
  "preview.toggle": "Toggle preview",
  "preview.refresh": "Refresh preview",
  "terminal.toggle": "Toggle terminal",
  "terminal.split": "Split terminal",
  "terminal.new": "New terminal",
  "terminal.close": "Close terminal",
  "thread.stop": "Stop the running turn",
  "thread.settle": "Settle thread",
  "thread.pin": "Pin thread",
  "thread.undo": "Undo thread action",
  "thread.snooze": "Snooze or wake thread",
  "thread.rename": "Rename thread",
  "approval.approve": "Approve",
  "approval.decline": "Decline",
  "navigation.back": "Back",
  "navigation.forward": "Forward",
  "threadPanel.toggle": "Toggle thread panel",
  "commandPalette.toggle": "Command palette",
  "filePicker.toggle": "Go to file",
  "projectSearch.toggle": "Search project",
  "usage.open": "Open usage",
  "theme.select": "Choose theme",
  "appearance.cycle": "Light, dark or system",
  "themeEditor.toggle": "Theme editor",
  "chat.new": "New thread",
  "chat.find": "Find in thread",
  "settings.open": "Open settings",
  "usage.cost": "Usage page: show cost",
  "usage.tokens": "Usage page: show tokens",
  "usage.limits": "Usage page: show limits",
  "keyboard.cheatSheet": "Keyboard shortcuts",
};

/** "Timeline: Cite With Note" reads as "Cite With Note" under the Timeline heading. */
function rowLabel(command: KeybindingCommand): string {
  const fixed = LABELS[command];
  if (fixed) return fixed;
  const label = commandLabel(command);
  const separator = label.indexOf(": ");
  return separator >= 0 ? label.slice(separator + 2) : label;
}

function keyLabels(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  context: Record<string, boolean>,
  platform: string,
): string[] {
  const shortcuts = effectiveShortcutsForCommand(keybindings, command, { context, platform });
  return [...new Set(shortcuts.map((shortcut) => formatShortcutLabel(shortcut, platform)))];
}

/**
 * Every command that has a key, grouped by the screen area where its key works. A key shows only
 * when it works in that area, so a command that another rule overrides there shows no key.
 * `here` moves its area to the top.
 */
export function buildCheatSheet(input: {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly platform: string;
  readonly isDesktop: boolean;
  readonly here: CheatSheetAreaId | null;
}): CheatSheetArea[] {
  const base = { isDesktop: input.isDesktop, isWeb: !input.isDesktop };
  const areas = AREAS.map((area) => {
    const rows: CheatSheetRow[] = [];
    for (const command of STATIC_KEYBINDING_COMMANDS) {
      if (FAMILY_MEMBERS.has(command) || areaOf(command) !== area.id) continue;
      const context = { ...base, ...area.context, ...EXTRA_CONTEXT[command] };
      const keys = keyLabels(input.keybindings, command, context, input.platform);
      if (keys.length > 0) rows.push({ command, label: rowLabel(command), keys });
    }
    for (const family of FAMILIES) {
      const [first] = family.commands;
      const last = family.commands.at(-1);
      if (!first || !last || areaOf(first) !== area.id) continue;
      const context = { ...base, ...area.context, ...family.context };
      const firstKey = keyLabels(input.keybindings, first, context, input.platform)[0];
      const lastKey = keyLabels(input.keybindings, last, context, input.platform)[0];
      if (firstKey && lastKey) {
        rows.push({ command: first, label: family.label, keys: [`${firstKey} – ${lastKey}`] });
      }
    }
    return { id: area.id, title: area.title, needsFocusLevels: area.needsFocusLevels, rows };
  }).filter((area) => area.rows.length > 0);
  return input.here === null
    ? areas
    : [
        ...areas.filter((area) => area.id === input.here),
        ...areas.filter((area) => area.id !== input.here),
      ];
}

/** Rows whose label or keys contain `query`, ignoring case. Areas left empty drop out. */
export function filterCheatSheet(
  areas: ReadonlyArray<CheatSheetArea>,
  query: string,
): CheatSheetArea[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...areas];
  return areas
    .map((area) => ({
      ...area,
      rows: area.rows.filter(
        (row) =>
          row.label.toLowerCase().includes(needle) ||
          area.title.toLowerCase().includes(needle) ||
          row.keys.some((key) => key.toLowerCase().includes(needle)),
      ),
    }))
    .filter((area) => area.rows.length > 0);
}
