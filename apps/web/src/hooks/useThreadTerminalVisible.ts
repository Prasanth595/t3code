import type { ScopedThreadRef } from "@t3tools/contracts";

import { isTerminalDockEligible, isTerminalDrawerVisible } from "../lib/terminalDock";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useMediaQuery } from "./useMediaQuery";
import { getClientSettingsSnapshot, useClientSettings } from "./useSettings";

// Shortcut `when` clauses describe the screen, so every dispatcher reads the
// drawer's visibility rather than its stored open flag: a docked drawer hidden
// with its closed right panel is not open.

/** Dock eligibility read at call time, for handlers outside React render. */
export function getTerminalDockEligibleSnapshot(): boolean {
  return isTerminalDockEligible({
    settingEnabled: getClientSettingsSnapshot().terminalDockRightPanel,
    sheetLayout: window.matchMedia(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).matches,
  });
}

/** Whether the thread's terminal drawer is visible, read at call time. */
export function getThreadTerminalVisibleSnapshot(threadRef: ScopedThreadRef | null): boolean {
  if (!threadRef) return false;
  return isTerminalDrawerVisible({
    dockEligible: getTerminalDockEligibleSnapshot(),
    rightPanelOpen: selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    ).isOpen,
    terminalOpen: selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      threadRef,
    ).terminalOpen,
  });
}

/** Whether the thread's terminal drawer is visible. */
export function useThreadTerminalVisible(threadRef: ScopedThreadRef | null): boolean {
  const settingEnabled = useClientSettings((settings) => settings.terminalDockRightPanel);
  const sheetLayout = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const terminalOpen = useTerminalUiStateStore((state) =>
    threadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef).terminalOpen
      : false,
  );
  const rightPanelOpen = useRightPanelStore((state) =>
    threadRef ? selectThreadRightPanelState(state.byThreadKey, threadRef).isOpen : false,
  );
  return isTerminalDrawerVisible({
    dockEligible: isTerminalDockEligible({ settingEnabled, sheetLayout }),
    rightPanelOpen,
    terminalOpen,
  });
}
