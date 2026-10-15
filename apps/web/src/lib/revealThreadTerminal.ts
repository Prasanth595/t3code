import type { ScopedThreadRef } from "@t3tools/contracts";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";

// `dockInRightPanel` is the caller's dock eligibility (setting on, inline
// layout). A docked drawer only shows inside the right panel, so revealing it
// opens that panel too.

/** Opens a docked drawer's right panel; a no-op when the panel is open or nothing is docked. */
export function showTerminalDockPanel(threadRef: ScopedThreadRef, dockInRightPanel: boolean) {
  if (!dockInRightPanel) return;
  const panels = useRightPanelStore.getState();
  if (!selectThreadRightPanelState(panels.byThreadKey, threadRef).isOpen) panels.show(threadRef);
}

/** Opens the drawer, as the new and split terminal shortcuts do before acting on it. */
export function openThreadTerminalDrawer(threadRef: ScopedThreadRef, dockInRightPanel: boolean) {
  const terminals = useTerminalUiStateStore.getState();
  if (!selectThreadTerminalUiState(terminals.terminalUiStateByThreadKey, threadRef).terminalOpen) {
    terminals.setTerminalOpen(threadRef, true);
  }
  showTerminalDockPanel(threadRef, dockInRightPanel);
}

/** Reveal an existing terminal in the panel that owns it, without opening another PTY. */
export function revealThreadTerminal(
  threadRef: ScopedThreadRef,
  terminalId: string,
  dockInRightPanel: boolean,
) {
  const panels = useRightPanelStore.getState();
  const surface = selectThreadRightPanelState(panels.byThreadKey, threadRef).surfaces.find(
    (surface) => surface.kind === "terminal" && surface.terminalIds.includes(terminalId),
  );
  if (surface) {
    panels.activateTerminal(threadRef, surface.id, terminalId);
    panels.activateSurface(threadRef, surface.id);
    return;
  }
  useTerminalUiStateStore.getState().ensureTerminal(threadRef, terminalId, {
    open: true,
    active: true,
  });
  showTerminalDockPanel(threadRef, dockInRightPanel);
}
