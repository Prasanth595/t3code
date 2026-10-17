import { FORK_KEYBINDING_COMMANDS, type ForkKeybindingCommand } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { getClientSettings, useClientSettings } from "../../hooks/useSettings";
import { resolveShortcutCommand } from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { isPreviewFocused } from "../../lib/previewFocus";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  type FocusLevel,
  focusLevel,
  focusLevelContext,
  focusLevelOf,
  focusLevelSideways,
  focusLevelUp,
  focusLevelsEnabled,
  setFocusLevelsEnabled,
  watchFocusLevelChanges,
} from "./focusLevels";

/** Runs a command for the focused element. False lets the key event through untouched. */
export type FocusLevelCommandHandler = (event: KeyboardEvent) => boolean;

const handlers = new Map<ForkKeybindingCommand, Set<FocusLevelCommandHandler>>();

/**
 * Components that own the state of a command register a handler while they are mounted, such as
 * the sidebar for thread actions and the timeline cursor for its keys.
 */
export function registerFocusLevelCommands(
  entries: Partial<Record<ForkKeybindingCommand, FocusLevelCommandHandler>>,
): () => void {
  const added: Array<[ForkKeybindingCommand, FocusLevelCommandHandler]> = [];
  for (const command of FORK_KEYBINDING_COMMANDS) {
    const handler = entries[command];
    if (!handler) continue;
    const set = handlers.get(command) ?? new Set();
    set.add(handler);
    handlers.set(command, set);
    added.push([command, handler]);
  }
  return () => {
    for (const [command, handler] of added) handlers.get(command)?.delete(handler);
  };
}

/**
 * Runs a registered command from outside the keyboard, such as the command palette. Thread
 * actions then act on the open thread, because no sidebar row has focus.
 */
export function runRegisteredFocusLevelCommand(command: ForkKeybindingCommand): boolean {
  const event = new KeyboardEvent("keydown");
  return Array.from(handlers.get(command) ?? []).some((handler) => handler(event));
}

const FORK_COMMANDS: ReadonlySet<string> = new Set(FORK_KEYBINDING_COMMANDS);

function isForkCommand(command: string): command is ForkKeybindingCommand {
  return FORK_COMMANDS.has(command);
}

/** The commands that `keyboardFocusLevels` turns on. */
function isLevelCommand(command: ForkKeybindingCommand): boolean {
  return (
    command.startsWith("focus.") ||
    command.startsWith("sidebar.") ||
    command.startsWith("timeline.")
  );
}

const DIRECT_FOCUS: Partial<Record<ForkKeybindingCommand, FocusLevel>> = {
  "focus.composer": "composer",
  "focus.timeline": "timeline",
  "focus.sidebar": "sidebar",
  "focus.rightPanel": "rightPanel",
};

function stepRightPanelTab(direction: 1 | -1): boolean {
  const tabs = Array.from(
    document.querySelectorAll<HTMLElement>("[data-right-panel-tab-activate]"),
  );
  if (tabs.length < 2) return false;
  const active = tabs.findIndex((tab) => tab.closest('[data-active-tab="true"]') !== null);
  const next = tabs[(active + direction + tabs.length) % tabs.length];
  if (!next) return false;
  next.click();
  return true;
}

/**
 * Fork: dispatches the fork keyboard commands for the whole app. Most run in the capture phase,
 * before the focused element's own key handler. Escape (`focus.up`) waits until every listener
 * had the event, and yields when any of them used it: a menu, an editor, the find bar, the sidebar
 * selection or the pull request page.
 */
export function useFocusLevelShortcuts() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const levelsSetting = useClientSettings((settings) => settings.keyboardFocusLevels);
  const navigate = useNavigate();
  const latest = useRef({ keybindings, navigate });
  useLayoutEffect(() => {
    latest.current = { keybindings, navigate };
    setFocusLevelsEnabled(levelsSetting);
  });

  useEffect(() => {
    const runBuiltIn = (command: ForkKeybindingCommand, target: EventTarget | null): boolean => {
      const level = focusLevelOf(target);
      const direct = DIRECT_FOCUS[command];
      if (direct) return focusLevel(direct);
      switch (command) {
        case "focus.up":
          return level !== null && focusLevelUp(level);
        case "focus.left":
          return level !== null && focusLevelSideways(level, "left");
        case "focus.right":
          return level !== null && focusLevelSideways(level, "right");
        case "rightPanel.previousTab":
          return stepRightPanelTab(-1);
        case "rightPanel.nextTab":
          return stepRightPanelTab(1);
        case "settings.open":
          void latest.current.navigate({ to: "/settings" });
          return true;
        default:
          return false;
      }
    };
    const resolve = (event: KeyboardEvent): ForkKeybindingCommand | null => {
      if (event.isComposing || isCommandPaletteOpen()) return null;
      const command = resolveShortcutCommand(event, latest.current.keybindings, {
        context: {
          terminalFocus: getTerminalFocusOwner() !== null,
          previewFocus: isPreviewFocused(),
          editableFocus: isEditableFocused(event.target),
          isWeb: !isElectron,
          isDesktop: isElectron,
          ...focusLevelContext(event.target),
        },
      });
      if (command === null || !isForkCommand(command)) return null;
      if (isLevelCommand(command) && !focusLevelsEnabled()) return null;
      return command;
    };
    const run = (command: ForkKeybindingCommand, event: KeyboardEvent): boolean =>
      Array.from(handlers.get(command) ?? []).some((handler) => handler(event)) ||
      runBuiltIn(command, event.target);

    const onCapture = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolve(event);
      if (command === null || command === "focus.up" || !run(command, event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    // Reached only when no element stopped the event. ProseMirror marks every Escape in the
    // composer as handled, so there a mark from before this point does not count as a use.
    const onDocumentEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || resolve(event) !== "focus.up") return;
      const markedByElement = event.defaultPrevented;
      if (markedByElement && focusLevelOf(event.target) !== "composer") return;
      // Window listeners run after this one, in registration order. Decide once all of them ran.
      setTimeout(() => {
        if (event.defaultPrevented !== markedByElement) return;
        run("focus.up", event);
      }, 0);
    };
    const stopWatching = watchFocusLevelChanges(() => getClientSettings().focusLevelHighlight);
    window.addEventListener("keydown", onCapture, true);
    document.addEventListener("keydown", onDocumentEscape);
    return () => {
      stopWatching();
      window.removeEventListener("keydown", onCapture, true);
      document.removeEventListener("keydown", onDocumentEscape);
    };
  }, []);
}
