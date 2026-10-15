import { describe, expect, it } from "vite-plus/test";

import {
  isTerminalDockEligible,
  isTerminalDrawerVisible,
  resolveTerminalToggle,
} from "./terminalDock";

describe("isTerminalDockEligible", () => {
  it("docks only with the setting on and the inline right panel layout", () => {
    expect(isTerminalDockEligible({ settingEnabled: true, sheetLayout: false })).toBe(true);
    expect(isTerminalDockEligible({ settingEnabled: true, sheetLayout: true })).toBe(false);
    expect(isTerminalDockEligible({ settingEnabled: false, sheetLayout: false })).toBe(false);
  });
});

describe("isTerminalDrawerVisible", () => {
  it("hides a docked drawer with its closed panel without depending on the panel otherwise", () => {
    expect(
      isTerminalDrawerVisible({ dockEligible: true, rightPanelOpen: false, terminalOpen: true }),
    ).toBe(false);
    expect(
      isTerminalDrawerVisible({ dockEligible: true, rightPanelOpen: true, terminalOpen: true }),
    ).toBe(true);
    expect(
      isTerminalDrawerVisible({ dockEligible: false, rightPanelOpen: false, terminalOpen: true }),
    ).toBe(true);
    expect(
      isTerminalDrawerVisible({ dockEligible: true, rightPanelOpen: true, terminalOpen: false }),
    ).toBe(false);
  });
});

describe("resolveTerminalToggle", () => {
  it("keeps the under-chat toggle independent of the right panel", () => {
    expect(
      resolveTerminalToggle({ dockEligible: false, rightPanelOpen: false, terminalOpen: false }),
    ).toEqual({ open: true, showRightPanel: false });
    expect(
      resolveTerminalToggle({ dockEligible: false, rightPanelOpen: true, terminalOpen: true }),
    ).toEqual({ open: false, showRightPanel: false });
  });

  it("toggles a docked drawer in place while its panel is open", () => {
    expect(
      resolveTerminalToggle({ dockEligible: true, rightPanelOpen: true, terminalOpen: false }),
    ).toEqual({ open: true, showRightPanel: false });
    expect(
      resolveTerminalToggle({ dockEligible: true, rightPanelOpen: true, terminalOpen: true }),
    ).toEqual({ open: false, showRightPanel: false });
  });

  it("opens the closed panel instead of closing a drawer hidden with it", () => {
    expect(
      resolveTerminalToggle({ dockEligible: true, rightPanelOpen: false, terminalOpen: true }),
    ).toEqual({ open: true, showRightPanel: true });
    expect(
      resolveTerminalToggle({ dockEligible: true, rightPanelOpen: false, terminalOpen: false }),
    ).toEqual({ open: true, showRightPanel: true });
  });
});
