import { FORK_KEYBINDING_COMMANDS, type ForkKeybindingCommand } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
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
 * Fork: dispatches the focus level commands for the whole app. Escape (`focus.up`) runs in the
 * bubble phase, after menus, popovers and editors had the chance to handle it themselves. The
 * other commands run in the capture phase, before the focused element's own key handler.
 */
export function useFocusLevelShortcuts() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const navigate = useNavigate();
  const latest = useRef({ keybindings, navigate });
  useLayoutEffect(() => {
    latest.current = { keybindings, navigate };
  });

  useEffect(() => {
    const runBuiltIn = (command: ForkKeybindingCommand, event: KeyboardEvent): boolean => {
      const level = focusLevelOf(event.target);
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
    const dispatch = (phase: "capture" | "bubble") => (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isCommandPaletteOpen()) return;
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
      if (command === null || !isForkCommand(command)) return;
      if ((command === "focus.up") !== (phase === "bubble")) return;
      const registered = Array.from(handlers.get(command) ?? []);
      const handled = registered.some((handler) => handler(event)) || runBuiltIn(command, event);
      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const stopWatching = watchFocusLevelChanges();
    const onCapture = dispatch("capture");
    const onBubble = dispatch("bubble");
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("keydown", onBubble);
    return () => {
      stopWatching();
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("keydown", onBubble);
    };
  }, []);
}
