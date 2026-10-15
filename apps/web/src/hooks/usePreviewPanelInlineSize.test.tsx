import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { usePreviewPanelInlineSize } from "./usePreviewPanelInlineSize";
const state = vi.hoisted(() => ({ resize: () => {} }));
vi.mock("../lib/observeResize", () => ({
  observeResize: (_: unknown, callback: () => void) => {
    state.resize = callback;
    return () => {};
  },
}));
let renderer: ReactTestRenderer;
let result: ReturnType<typeof usePreviewPanelInlineSize>;
const row = { clientWidth: 1500 };
function Panel({
  balanced = true,
  storageKey = "sidechat",
}: {
  balanced?: boolean;
  storageKey?: string;
}) {
  const size = usePreviewPanelInlineSize(undefined, {
    container: row as HTMLElement,
    balancedDefault: balanced,
    widthStorageKey: storageKey,
  });
  useLayoutEffect(() => {
    result = size;
  });
  return null;
}
beforeEach(async () => {
  const events = new EventTarget();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    innerWidth: 1920,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    localStorage: { getItem: () => null, setItem: vi.fn() },
  });
  row.clientWidth = 1500;
  await act(() => {
    renderer = create(<Panel />);
  });
});
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});
it("starts at half the available row and follows a sidebar resize before any explicit drag", async () => {
  expect(result.width).toBe(750);
  row.clientWidth = 1200;
  await act(() => state.resize());
  expect(result.width).toBe(600);
  row.clientWidth = 800;
  await act(() => state.resize());
  expect(result.width).toBe(400);
  row.clientWidth = 650;
  await act(() => state.resize());
  expect(result.width).toBe(360);
});
it("keeps the normal file/browser default when the active surface changes", async () => {
  expect(result.width).toBe(750);
  await act(() => renderer.update(<Panel balanced={false} storageKey="browser" />));
  expect(result.width).toBe(540);
});
