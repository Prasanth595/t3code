// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { PopoverCreateHandle } from "../ui/popover";
import { useRightPanelStore } from "../../rightPanelStore";
const threadRef = {
  environmentId: EnvironmentId.make("layout-fixture"),
  threadId: ThreadId.make("main"),
};
const containerSize = { width: 1600, height: 900 };
const report = vi.fn();
const presentation = vi.fn();
const canvas = {
  container: containerSize,
  lane: { padding: 48, minChatWidth: 640 },
  layout: resolveChatCanvasLayout({ container: containerSize, preview: null }),
  previewKey: null,
  reportPreview: vi.fn(),
  clearPreview: vi.fn(),
  registerTimeline: vi.fn(),
  reportDetailsCard: report,
  detailsCardTopInset: 0,
};
let root: Root;
let container: HTMLDivElement;
function Fixture({ sidechat = false }: { sidechat?: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [handle] = useState(PopoverCreateHandle);
  return (
    <ChatCanvasContext value={canvas}>
      <button
        ref={anchor}
        onClick={() => useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", true)}
      >
        Workspace details
      </button>
      <ThreadDetailsCard
        threadRef={threadRef}
        anchor={anchor}
        handle={handle}
        onPresentationChange={presentation}
        popoverOnly={sidechat}
      >
        {() => <span>Workspace content</span>}
      </ThreadDetailsCard>
    </ChatCanvasContext>
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  presentation.mockClear();
  report.mockClear();
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("yields the main column while sidechat is open, keeps details accessible, and restores the inline preference", async () => {
  await act(() => root.render(<Fixture />));
  expect(document.querySelector('[data-thread-details-panel="inline"]')).not.toBeNull();
  await act(() => root.render(<Fixture sidechat />));
  expect(document.querySelector('[data-thread-details-panel="inline"]')).toBeNull();
  expect(presentation).toHaveBeenLastCalledWith("popover");
  expect(report).toHaveBeenLastCalledWith(null);
  await act(() => container.querySelector("button")!.click());
  await act(() => vi.advanceTimersToNextFrame());
  expect(document.querySelector('[data-thread-details-panel="popover"]')?.textContent).toContain(
    "Workspace content",
  );
  await act(() => root.render(<Fixture />));
  expect(document.querySelector('[data-thread-details-panel="inline"]')).not.toBeNull();
  expect(presentation).toHaveBeenLastCalledWith("inline");
});
