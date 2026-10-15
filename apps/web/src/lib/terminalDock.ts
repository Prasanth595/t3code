// The "Dock terminal in right panel" setting moves the terminal drawer into the
// inline right panel. Eligibility is independent of whether the panel is open:
// while eligible the drawer never renders under the chat, so a closed panel
// hides the drawer without clearing its stored open state.

interface TerminalDockState {
  /** Setting on and the right panel is inline (not the narrow-window sheet). */
  readonly dockEligible: boolean;
  readonly rightPanelOpen: boolean;
  /** Stored drawer state from terminalUiStateStore. */
  readonly terminalOpen: boolean;
}

export function isTerminalDockEligible(input: {
  readonly settingEnabled: boolean;
  readonly sheetLayout: boolean;
}): boolean {
  return input.settingEnabled && !input.sheetLayout;
}

/** Whether the user can see the drawer, as opposed to whether it is stored open. */
export function isTerminalDrawerVisible(state: TerminalDockState): boolean {
  return state.terminalOpen && (!state.dockEligible || state.rightPanelOpen);
}

/**
 * Cmd+J and the header toggle act on what is visible: a docked drawer hidden
 * with its closed panel is revealed (panel opened), not closed.
 */
export function resolveTerminalToggle(state: TerminalDockState): {
  readonly open: boolean;
  readonly showRightPanel: boolean;
} {
  const open = !isTerminalDrawerVisible(state);
  return { open, showRightPanel: open && state.dockEligible && !state.rightPanelOpen };
}
