import "../../index.css";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock(import("../SidebarStageBackdrop"), async (original) => ({
  ...(await original()),
  useSidebarStageBackdropVariant: () => null,
}));

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

describe("ComposerPrimaryActions stop pending state", () => {
  const onInterrupt = vi.fn();
  const onResume = vi.fn();
  function runningProps(canInterrupt: boolean, canOperateThread = true) {
    return {
      compact: true,
      canOperateThread,
      pendingAction: null,
      isRunning: canInterrupt,
      canInterrupt,
      canResume: !canInterrupt,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt,
      onResume,
      onImplementPlanInNewThread: () => {},
    };
  }

  let container: HTMLDivElement;
  let root: Root;
  const render = (canInterrupt: boolean, canOperateThread = true) =>
    act(() =>
      root.render(
        createElement(ComposerPrimaryActions, runningProps(canInterrupt, canOperateThread)),
      ),
    );
  const slot = () => [...container.querySelectorAll("button")].at(-1)!;
  const clickStop = () => act(() => slot().click());

  beforeEach(() => {
    onInterrupt.mockClear();
    onResume.mockClear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    render(true);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps repeat Stop clicks inert after the stop lands, with a separate Resume target", () => {
    clickStop();
    expect(slot()).toMatchObject({ ariaLabel: "Stopping", disabled: true });

    render(false);
    act(() => vi.advanceTimersByTime(1_100));
    for (let i = 0; i < 20; i++) clickStop();
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
    expect(slot()).toMatchObject({ ariaLabel: "Stopped", disabled: true });

    const resume = container.querySelector<HTMLButtonElement>('button[aria-label="Resume thread"]');
    expect(resume?.disabled).toBe(false);
    act(() => resume?.click());
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("enables Stop at once for a new run started after the stop lands", () => {
    clickStop();
    render(false);
    render(true);

    expect(slot()).toMatchObject({ ariaLabel: "Stop generation", disabled: false });
  });

  it("re-enables Stop when the stop never lands", () => {
    clickStop();

    act(() => vi.advanceTimersByTime(10_000));
    expect(slot()).toMatchObject({ ariaLabel: "Stop generation", disabled: false });
  });

  it("keeps repeat Stop clicks away from Resume when the stop lands after the timeout", () => {
    clickStop();
    act(() => vi.advanceTimersByTime(10_000));

    render(false);
    for (let i = 0; i < 20; i++) clickStop();
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
    expect(slot()).toMatchObject({ ariaLabel: "Stopped", disabled: true });
  });

  it("sends Stop again after the timeout and waits for it to land", () => {
    clickStop();
    act(() => vi.advanceTimersByTime(10_000));

    clickStop();
    expect(onInterrupt).toHaveBeenCalledTimes(2);
    expect(slot()).toMatchObject({ ariaLabel: "Stopping", disabled: true });
  });

  it("does not read a lost operate permission as a landed stop", () => {
    clickStop();
    // ChatView folds the permission into canInterrupt, so a flap drops both.
    render(false, false);
    render(true);

    expect(slot()).toMatchObject({ ariaLabel: "Stopping", disabled: true });
    expect(container.querySelector('button[aria-label="Resume thread"]')).toBeNull();
  });
});
