import {
  type ContextMenuItem,
  type ForkKeybindingCommand,
  type LocalApi,
  type ScopedThreadRef,
  SIDEBAR_GROUP_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import type { ThreadActionMenuId } from "../threadActionMenu.logic";
import { focusLevel, focusLevelElement, focusLevelOf, SIDEBAR_ROW_SELECTOR } from "./focusLevels";
import {
  type FocusLevelCommandHandler,
  registerFocusLevelCommands,
} from "./useFocusLevelShortcuts";

const GROUP_TAB_SELECTOR = '[data-sidebar-group-tabs] [role="tab"]';

/** The thread menu items that a thread action key picks, in order of preference. */
const THREAD_ACTION_PRESETS = {
  "thread.archive": ["archive"],
  "thread.snooze": ["snooze", "unsnooze"],
  "thread.rename": ["rename"],
  "thread.markUnread": ["mark-unread"],
} as const satisfies Partial<Record<ForkKeybindingCommand, ReadonlyArray<ThreadActionMenuId>>>;

export type ThreadActionPreset = (typeof THREAD_ACTION_PRESETS)[keyof typeof THREAD_ACTION_PRESETS];

function findEnabledItem(
  items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
  id: ThreadActionMenuId,
): ContextMenuItem<ThreadActionMenuId> | null {
  for (const item of items) {
    if (item.id === id) return item.disabled ? null : item;
    const child = item.children ? findEnabledItem(item.children, id) : null;
    if (child) return child;
  }
  return null;
}

/**
 * Fork: the thread menu with a key preset picks that item instead of opening the menu. An item
 * with a submenu, such as Snooze, opens only its submenu. A disabled or missing item does nothing,
 * so a key follows the same rules as the menu.
 */
export function showThreadActionMenu(
  api: LocalApi,
  items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
  position: { x: number; y: number },
  preset: ThreadActionPreset | undefined,
): Promise<ThreadActionMenuId | null> {
  if (!preset) return api.contextMenu.show(items, position);
  for (const id of preset) {
    const item = findEnabledItem(items, id);
    if (!item) continue;
    if (item.children) return api.contextMenu.show(item.children, position);
    return Promise.resolve(item.id);
  }
  return Promise.resolve(null);
}

function sidebarRows(): HTMLElement[] {
  return Array.from(
    focusLevelElement("sidebar")?.querySelectorAll<HTMLElement>(SIDEBAR_ROW_SELECTOR) ?? [],
  );
}

function groupTabs(): HTMLElement[] {
  return Array.from(
    focusLevelElement("sidebar")?.querySelectorAll<HTMLElement>(GROUP_TAB_SELECTOR) ?? [],
  );
}

function focusedRow(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement &&
    document.activeElement.matches(SIDEBAR_ROW_SELECTOR)
    ? document.activeElement
    : null;
}

function focusRow(row: HTMLElement | undefined): boolean {
  if (!row) return false;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: "nearest" });
  return true;
}

/** Under the thread's row, so a submenu such as Snooze opens next to it. */
function threadMenuPosition(threadKey: string): { x: number; y: number } {
  const row = focusLevelElement("sidebar")
    ?.querySelector<HTMLElement>(`[data-thread-item="${CSS.escape(threadKey)}"]`)
    ?.querySelector<HTMLElement>(SIDEBAR_ROW_SELECTOR);
  const rect = row?.getBoundingClientRect();
  return rect
    ? { x: rect.left + 16, y: rect.bottom }
    : { x: window.innerWidth / 2, y: window.innerHeight / 3 };
}

/** Runs after the next paint, once React rendered the result of a click. */
function afterPaint(run: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(run));
}

function selectGroup(index: number): boolean {
  const tabs = groupTabs();
  const tab = tabs[index];
  if (!tab) return false;
  const tabHadFocus =
    document.activeElement instanceof HTMLElement && tabs.includes(document.activeElement);
  tab.click();
  afterPaint(() => {
    if (tabHadFocus) tab.focus();
    else focusRow(sidebarRows()[0]);
  });
  return true;
}

function stepGroup(direction: 1 | -1): boolean {
  const tabs = groupTabs();
  if (tabs.length < 2) return false;
  const selected = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
  return selectGroup((selected + direction + tabs.length) % tabs.length);
}

/**
 * Fork: keyboard control of the sidebar. Up and Down move between thread rows, and Up from the
 * first row reaches the group tabs. Thread action keys act on the focused row in the sidebar, and
 * on the open thread elsewhere.
 */
export function useSidebarKeyboard(input: {
  readonly routeThreadRef: ScopedThreadRef | null;
  readonly searchFieldRef: RefObject<HTMLElement | null>;
  readonly runThreadAction: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    preset: ThreadActionPreset,
  ) => void;
}) {
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });

  useEffect(() => {
    const step =
      (direction: 1 | -1): FocusLevelCommandHandler =>
      () => {
        const rows = sidebarRows();
        const row = focusedRow();
        const tabs = groupTabs();
        const onTab =
          document.activeElement instanceof HTMLElement && tabs.includes(document.activeElement);
        if (row === null)
          return direction === 1 && (onTab || rows.length > 0) ? focusRow(rows[0]) : false;
        const index = rows.indexOf(row);
        if (direction === -1 && index === 0) {
          const selectedTab = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
          selectedTab?.focus();
          return true;
        }
        return focusRow(rows[index + direction]) || true;
      };
    const threadAction =
      (command: keyof typeof THREAD_ACTION_PRESETS): FocusLevelCommandHandler =>
      (event) => {
        if (event.repeat) return true;
        const inSidebar = focusLevelOf(event.target) === "sidebar";
        const threadKey = inSidebar
          ? focusedRow()?.closest<HTMLElement>("[data-thread-item]")?.dataset.threadItem
          : undefined;
        const threadRef = inSidebar
          ? threadKey
            ? parseScopedThreadKey(threadKey)
            : null
          : latest.current.routeThreadRef;
        if (!threadRef) return false;
        latest.current.runThreadAction(
          threadRef,
          threadMenuPosition(scopedThreadKey(threadRef)),
          THREAD_ACTION_PRESETS[command],
        );
        return true;
      };
    const groupJumps = Object.fromEntries(
      SIDEBAR_GROUP_JUMP_KEYBINDING_COMMANDS.map((command, index) => [
        command,
        (() => selectGroup(index)) satisfies FocusLevelCommandHandler,
      ]),
    );
    return registerFocusLevelCommands({
      "sidebar.previousItem": step(-1),
      "sidebar.nextItem": step(1),
      "sidebar.openItem": () => {
        const row = focusedRow();
        if (!row) return false;
        row.click();
        afterPaint(() => focusLevel("timeline"));
        return true;
      },
      "sidebar.previousGroup": () => stepGroup(-1),
      "sidebar.nextGroup": () => stepGroup(1),
      "sidebar.search": () => {
        const field = latest.current.searchFieldRef.current?.querySelector<HTMLElement>("input");
        if (!field) return false;
        field.focus();
        return true;
      },
      ...groupJumps,
      "thread.archive": threadAction("thread.archive"),
      "thread.snooze": threadAction("thread.snooze"),
      "thread.rename": threadAction("thread.rename"),
      "thread.markUnread": threadAction("thread.markUnread"),
    });
  }, []);
}
