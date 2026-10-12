// @vitest-environment jsdom

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { ThreadTerminalStatusButton } from "./ThreadStatusIndicators";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("thread-1"));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  useRightPanelStore.setState({ byThreadKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function terminalOpen() {
  return selectThreadTerminalUiState(
    useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
    threadRef,
  ).terminalOpen;
}

async function renderButton(
  props: Pick<
    Parameters<typeof ThreadTerminalStatusButton>[0],
    "terminalIds" | "pendingBackgroundTasks"
  >,
) {
  const onThreadActivate = vi.fn();
  await act(async () => {
    root.render(
      <ThreadTerminalStatusButton
        threadRef={threadRef}
        onThreadActivate={onThreadActivate}
        {...props}
      />,
    );
  });
  return {
    onThreadActivate,
    button: container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-terminal-status-thread-1"]',
    ),
  };
}

describe("ThreadTerminalStatusButton", () => {
  it("shows a live background command and opens the thread, not a terminal", async () => {
    const { button, onThreadActivate } = await renderButton({
      terminalIds: [],
      pendingBackgroundTasks: [{ taskId: "bg-1", kind: "command", description: "vp run dev" }],
    });

    expect(button?.getAttribute("aria-label")).toBe("Running: vp run dev. Open thread");
    await act(async () => button?.click());
    expect(onThreadActivate).toHaveBeenCalledWith(threadRef);
    expect(terminalOpen()).toBe(false);
  });

  it("reveals the integrated terminal when one is running", async () => {
    const { button, onThreadActivate } = await renderButton({
      terminalIds: ["term-1"],
      pendingBackgroundTasks: [{ taskId: "bg-1", kind: "command" }],
    });

    await act(async () => button?.click());
    expect(onThreadActivate).toHaveBeenCalledWith(threadRef);
    expect(terminalOpen()).toBe(true);
  });

  it.each(["subagent", "monitor", "background_task"] as const)(
    "stays hidden for %s work, which already holds the thread's status",
    async (kind) => {
      const { button } = await renderButton({
        terminalIds: [],
        pendingBackgroundTasks: [{ taskId: "bg-1", kind }],
      });

      expect(button).toBeNull();
    },
  );
});
