import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { openThreadTerminalDrawer, revealThreadTerminal } from "./revealThreadTerminal";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("settled-thread"));
const remoteRef = scopeThreadRef(EnvironmentId.make("remote"), threadRef.threadId);
const otherRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("other-thread"));

const drawerState = (ref: typeof threadRef) =>
  selectThreadTerminalUiState(useTerminalUiStateStore.getState().terminalUiStateByThreadKey, ref);
const panelState = (ref: typeof threadRef) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);

beforeEach(() => {
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  useRightPanelStore.setState({ byThreadKey: {} });
});

it("reveals a server-created setup terminal without adding a default shell", () => {
  revealThreadTerminal(threadRef, "setup-install", false);
  expect(
    selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      threadRef,
    ),
  ).toMatchObject({
    terminalOpen: true,
    terminalIds: ["setup-install"],
    activeTerminalId: "setup-install",
  });
});

it("reopens the existing panel and selects a running terminal in its split", () => {
  const panels = useRightPanelStore.getState();
  panels.openTerminal(threadRef, "terminal-1");
  const surfaceId = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  ).activeSurfaceId!;
  panels.splitTerminal(threadRef, surfaceId, "setup-install");
  panels.activateTerminal(threadRef, surfaceId, "terminal-1");
  panels.close(threadRef);

  revealThreadTerminal(threadRef, "setup-install", false);
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef),
  ).toMatchObject({
    isOpen: true,
    activeSurfaceId: surfaceId,
    surfaces: [
      {
        terminalIds: ["terminal-1", "setup-install"],
        activeTerminalId: "setup-install",
      },
    ],
  });
  expect(
    selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      threadRef,
    ).terminalIds,
  ).toEqual([]);
});

it("reveals terminals in their own environment without changing another environment's drawer", () => {
  revealThreadTerminal(threadRef, "default", false);
  revealThreadTerminal(remoteRef, "setup-install", false);
  const state = useTerminalUiStateStore.getState().terminalUiStateByThreadKey;
  expect(selectThreadTerminalUiState(state, threadRef).terminalIds).toEqual(["default"]);
  expect(selectThreadTerminalUiState(state, remoteRef).terminalIds).toEqual(["setup-install"]);
});

it("opens another thread's closed right panel when revealing its docked drawer terminal", () => {
  revealThreadTerminal(otherRef, "setup-install", true);
  expect(drawerState(otherRef)).toMatchObject({
    terminalOpen: true,
    terminalIds: ["setup-install"],
    activeTerminalId: "setup-install",
  });
  expect(panelState(otherRef)).toMatchObject({ isOpen: true, activeSurfaceId: null });
  expect(panelState(threadRef).isOpen).toBe(false);
});

it("leaves the right panel closed when the drawer is not docked", () => {
  revealThreadTerminal(otherRef, "setup-install", false);
  expect(drawerState(otherRef).terminalOpen).toBe(true);
  expect(panelState(otherRef).isOpen).toBe(false);
});

it("still prefers a right panel terminal surface when docked", () => {
  useRightPanelStore.getState().openTerminal(threadRef, "terminal-1");
  useRightPanelStore.getState().close(threadRef);
  revealThreadTerminal(threadRef, "terminal-1", true);
  expect(panelState(threadRef).isOpen).toBe(true);
  expect(drawerState(threadRef).terminalIds).toEqual([]);
});

it("opens a docked drawer and its closed panel for the new and split shortcuts", () => {
  openThreadTerminalDrawer(threadRef, true);
  expect(drawerState(threadRef)).toMatchObject({ terminalOpen: true, terminalIds: ["term-1"] });
  expect(panelState(threadRef).isOpen).toBe(true);
});

it("reveals an already-open docked drawer by reopening only its panel", () => {
  openThreadTerminalDrawer(threadRef, false);
  useTerminalUiStateStore.getState().newTerminal(threadRef, "terminal-2");
  const before = drawerState(threadRef);
  openThreadTerminalDrawer(threadRef, true);
  expect(drawerState(threadRef)).toBe(before);
  expect(panelState(threadRef).isOpen).toBe(true);
});

it("does not record a right panel user action when the docked panel is already open", () => {
  useRightPanelStore.getState().show(threadRef);
  const before = useRightPanelStore.getState();
  openThreadTerminalDrawer(threadRef, true);
  expect(useRightPanelStore.getState()).toBe(before);
});
