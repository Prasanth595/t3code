import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  applyTerminalAttachStreamEvent,
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  nextTerminalAttachSeedState,
} from "@t3tools/client-runtime/state/terminal";

import {
  shouldClearTerminalSelectionAction,
  shouldHandleTerminalExit,
  terminalContextMenuItems,
  synchronizeTerminalOutput,
  terminalSelectionLineRange,
  terminalSelectionMenuItems,
  terminalThemeFromApp,
} from "./ThreadTerminalDrawer";

describe("terminal selection menus", () => {
  it("omits Add to chat when the terminal has no chat target", () => {
    expect(terminalSelectionMenuItems().map(({ id }) => id)).toEqual(["add-to-chat", "copy"]);
    expect(terminalContextMenuItems({ hasSelection: true }).map(({ id }) => id)).toEqual([
      "add-to-chat",
      "copy",
      "paste",
      "select-all",
      "scroll-to-bottom",
    ]);

    expect(terminalSelectionMenuItems({ canAddToChat: false }).map(({ id }) => id)).toEqual([
      "copy",
    ]);
    expect(
      terminalContextMenuItems({ hasSelection: true, canAddToChat: false }).map(({ id }) => id),
    ).toEqual(["copy", "paste", "select-all", "scroll-to-bottom"]);
  });

  it("keeps local viewing actions available to a read-only observer", () => {
    const items = terminalContextMenuItems({ hasSelection: false, readOnly: true });
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual([
      "add-to-chat",
      "copy",
      "paste",
    ]);
    expect(items.filter((item) => !item.disabled).map((item) => item.id)).toEqual([
      "select-all",
      "scroll-to-bottom",
    ]);
  });
});

describe("terminalThemeFromApp", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses terminal colors inherited by the mount instead of a light document theme", () => {
    const root = { classList: { contains: () => false } };
    const body = {};
    const drawer = {};
    let canvasColor = "#000";
    const colors: Record<string, [number, number, number, number]> = {
      "#000": [0, 0, 0, 255],
      "#fff": [255, 255, 255, 255],
      "#ddd": [221, 221, 221, 255],
      "#111": [17, 17, 17, 255],
    };

    vi.stubGlobal("document", {
      documentElement: root,
      body,
      querySelector: () => drawer,
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          clearRect: () => undefined,
          fillRect: () => undefined,
          get fillStyle() {
            return canvasColor;
          },
          set fillStyle(value: string) {
            canvasColor = value;
          },
          getImageData: () => ({ data: colors[canvasColor] ?? [0, 0, 0, 0] }),
        }),
      }),
    });
    vi.stubGlobal("getComputedStyle", (element: object) => {
      const local = element === drawer;
      const values = local
        ? {
            "--terminal-background": "#000",
            "--terminal-foreground": "#fff",
            "--terminal-cursor": "#ddd",
            "--terminal-selection-background": "rgba(255, 255, 255, 0.2)",
          }
        : {
            "--terminal-background": "#fff",
            "--terminal-foreground": "#111",
          };
      return {
        backgroundColor: local ? "#000" : "#fff",
        color: local ? "#fff" : "#111",
        colorScheme: local ? "dark" : "light",
        getPropertyValue: (name: string) => values[name as keyof typeof values] ?? "",
      };
    });

    const theme = terminalThemeFromApp();

    expect(theme.background).toEqual({ r: 0, g: 0, b: 0 });
    expect(theme.foreground).toEqual({ r: 255, g: 255, b: 255 });
    expect(theme.cursor).toEqual({ r: 221, g: 221, b: 221 });
  });
});

describe("terminal selection actions", () => {
  it("clears a pending or currently owned menu when the selection disappears", () => {
    expect(
      shouldClearTerminalSelectionAction({
        actionPending: true,
        openMenuRequestId: null,
        currentRequestId: 4,
      }),
    ).toBe(true);
    expect(
      shouldClearTerminalSelectionAction({
        actionPending: false,
        openMenuRequestId: 4,
        currentRequestId: 4,
      }),
    ).toBe(true);
  });

  it("does not let an old selection popup cancel its replacement right-click menu", () => {
    expect(
      shouldClearTerminalSelectionAction({
        actionPending: false,
        openMenuRequestId: 3,
        currentRequestId: 4,
      }),
    ).toBe(false);
    expect(
      shouldClearTerminalSelectionAction({
        actionPending: false,
        openMenuRequestId: null,
        currentRequestId: 4,
      }),
    ).toBe(false);
  });

  it("uses Ghostty's physical screen range for visually wrapped selections", () => {
    expect(
      terminalSelectionLineRange({
        start: { y: 4 },
        end: { y: 6 },
      }),
    ).toEqual({ lineStart: 5, lineEnd: 7 });
  });

  it("handles an exit that lands while the terminal surface is still loading", () => {
    expect(shouldHandleTerminalExit("exited", "running", false, 1)).toBe(true);
    expect(shouldHandleTerminalExit("exited", "exited", false, 1)).toBe(false);
    expect(shouldHandleTerminalExit("closed", "running", true, 1)).toBe(false);
  });

  it.each(["closed", "exited"] as const)("ignores an unsynchronized %s seed", (status) => {
    expect(shouldHandleTerminalExit(status, "running", false, 0)).toBe(false);
    expect(shouldHandleTerminalExit(status, "running", false, 1)).toBe(true);
  });
});

it("retains visible output and selection until a replacement subscription receives its snapshot", () => {
  const terminal = {
    resetAndWrite: vi.fn(),
    write: vi.fn(),
    clearSelection: vi.fn(),
    hasSelection: vi.fn(() => false),
  };
  const snapshot = {
    threadId: "thread",
    terminalId: "term-1",
    cwd: "/repo",
    worktreePath: null,
    status: "running" as const,
    pid: 123,
    history: "host output",
    exitCode: null,
    exitSignal: null,
    label: "Terminal 1",
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
  const attached = applyTerminalAttachStreamEvent(nextTerminalAttachSeedState(), {
    type: "snapshot",
    snapshot,
  });
  const cursor = synchronizeTerminalOutput(terminal, attached, INITIAL_TERMINAL_OUTPUT_CURSOR);
  expect(terminal.resetAndWrite).toHaveBeenLastCalledWith("host output");
  terminal.resetAndWrite.mockClear();
  terminal.clearSelection.mockClear();

  const pending = combineTerminalSessionState(
    { ...snapshot, hasRunningSubprocess: false },
    EMPTY_TERMINAL_BUFFER_STATE,
  );
  expect(pending.status).toBe("running");
  expect(synchronizeTerminalOutput(terminal, pending, cursor)).toBe(cursor);
  expect(terminal.resetAndWrite).not.toHaveBeenCalled();
  expect(terminal.write).not.toHaveBeenCalled();
  expect(terminal.clearSelection).not.toHaveBeenCalled();

  const observed = applyTerminalAttachStreamEvent(nextTerminalAttachSeedState(), {
    type: "snapshot",
    snapshot: { ...snapshot, history: "host output\nobserved output" },
  });
  const observedCursor = synchronizeTerminalOutput(terminal, observed, cursor);
  expect(terminal.resetAndWrite).toHaveBeenLastCalledWith("host output\nobserved output");

  const cleared = applyTerminalAttachStreamEvent(observed, {
    type: "cleared",
    threadId: "thread",
    terminalId: "term-1",
  });
  synchronizeTerminalOutput(terminal, cleared, observedCursor);
  expect(terminal.resetAndWrite).toHaveBeenLastCalledWith("");
});

describe("synchronizeTerminalOutput selection", () => {
  const SNAPSHOT = {
    threadId: "thread",
    terminalId: "term-1",
    cwd: "/repo",
    worktreePath: null,
    status: "running" as const,
    pid: 123,
    history: "build started",
    exitCode: null,
    exitSignal: null,
    label: "Terminal 1",
    updatedAt: "2026-09-05T00:00:00.000Z",
  };

  function createTerminal(hasSelection: boolean) {
    return {
      resetAndWrite: vi.fn(),
      write: vi.fn(),
      clearSelection: vi.fn(),
      hasSelection: vi.fn(() => hasSelection),
    };
  }

  function attachedSession() {
    return applyTerminalAttachStreamEvent(nextTerminalAttachSeedState(), {
      type: "snapshot",
      snapshot: SNAPSHOT,
    });
  }

  function appendOutput(session: ReturnType<typeof attachedSession>, data: string) {
    return applyTerminalAttachStreamEvent(session, {
      type: "output",
      threadId: SNAPSHOT.threadId,
      terminalId: SNAPSHOT.terminalId,
      data,
    });
  }

  it("keeps an unselected terminal untouched by appended output", () => {
    const terminal = createTerminal(false);
    const session = attachedSession();
    const cursor = synchronizeTerminalOutput(terminal, session, INITIAL_TERMINAL_OUTPUT_CURSOR);
    terminal.resetAndWrite.mockClear();
    terminal.clearSelection.mockClear();

    const next = appendOutput(session, "\r\nstep 2 done");
    synchronizeTerminalOutput(terminal, next, cursor);

    expect(terminal.write).toHaveBeenLastCalledWith("\r\nstep 2 done");
    expect(terminal.clearSelection).not.toHaveBeenCalled();
  });

  it("clears a selection that appended output could scroll out from under it", () => {
    const terminal = createTerminal(true);
    const session = attachedSession();
    const cursor = synchronizeTerminalOutput(terminal, session, INITIAL_TERMINAL_OUTPUT_CURSOR);
    terminal.clearSelection.mockClear();

    synchronizeTerminalOutput(terminal, appendOutput(session, "\r\nstep 2 done"), cursor);

    expect(terminal.clearSelection).toHaveBeenCalledTimes(1);
  });

  it("clears the selection on a reset even when nothing is selected", () => {
    const terminal = createTerminal(false);
    const session = attachedSession();
    const cursor = synchronizeTerminalOutput(terminal, session, INITIAL_TERMINAL_OUTPUT_CURSOR);
    terminal.clearSelection.mockClear();

    const replayed = applyTerminalAttachStreamEvent(nextTerminalAttachSeedState(), {
      type: "snapshot",
      snapshot: { ...SNAPSHOT, history: "replayed history" },
    });
    synchronizeTerminalOutput(terminal, replayed, cursor);

    expect(terminal.resetAndWrite).toHaveBeenLastCalledWith("replayed history");
    expect(terminal.clearSelection).toHaveBeenCalledTimes(1);
  });
});
