import { nextTerminalId } from "@t3tools/shared/terminalLabels";

/**
 * Picks the drawer terminal a project action runs in. Reuses the active (or first) idle drawer
 * terminal, otherwise allocates a fresh id. Right-panel terminals are never reused, so one PTY
 * never renders in both the drawer and the panel.
 */
export function resolveProjectScriptTerminal(input: {
  readonly drawerTerminalIds: ReadonlyArray<string>;
  readonly activeTerminalId: string;
  readonly panelTerminalIds: ReadonlySet<string>;
  readonly allocatableTerminalIds: ReadonlyArray<string>;
  readonly runningTerminalIds: ReadonlyArray<string>;
  readonly preferNewTerminal: boolean;
}): { readonly terminalId: string; readonly isNew: boolean } {
  const drawerTerminalIds = input.drawerTerminalIds.filter(
    (terminalId) => !input.panelTerminalIds.has(terminalId),
  );
  const baseTerminalId = drawerTerminalIds.includes(input.activeTerminalId)
    ? input.activeTerminalId
    : drawerTerminalIds[0];
  if (
    baseTerminalId !== undefined &&
    !input.preferNewTerminal &&
    !input.runningTerminalIds.includes(baseTerminalId)
  ) {
    return { terminalId: baseTerminalId, isNew: false };
  }
  return { terminalId: nextTerminalId(input.allocatableTerminalIds), isNew: true };
}
