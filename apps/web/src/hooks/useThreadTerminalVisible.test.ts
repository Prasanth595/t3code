import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { __setClientSettingsForTests } from "./useSettings";
import { getThreadTerminalVisibleSnapshot } from "./useThreadTerminalVisible";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("dock-thread"));

function arrange(input: { docked: boolean; sheetLayout: boolean; panelOpen: boolean }) {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, terminalDockRightPanel: input.docked });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: input.sheetLayout }) });
  useTerminalUiStateStore.getState().setTerminalOpen(threadRef, true);
  if (input.panelOpen) useRightPanelStore.getState().show(threadRef);
}

beforeEach(() => {
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  useRightPanelStore.setState({ byThreadKey: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
});

it("treats a docked drawer hidden with its closed right panel as closed", () => {
  arrange({ docked: true, sheetLayout: false, panelOpen: false });
  expect(getThreadTerminalVisibleSnapshot(threadRef)).toBe(false);
});

it("treats a docked drawer as open once its right panel is open", () => {
  arrange({ docked: true, sheetLayout: false, panelOpen: true });
  expect(getThreadTerminalVisibleSnapshot(threadRef)).toBe(true);
});

it("ignores the dock setting in the narrow sheet layout", () => {
  arrange({ docked: true, sheetLayout: true, panelOpen: false });
  expect(getThreadTerminalVisibleSnapshot(threadRef)).toBe(true);
});
