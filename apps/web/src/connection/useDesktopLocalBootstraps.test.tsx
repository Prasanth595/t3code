import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useDesktopLocalBootstraps } from "./useDesktopLocalBootstraps";

const wsl: DesktopEnvironmentBootstrap = {
  id: "wsl:Ubuntu",
  label: "WSL (Ubuntu)",
  runningDistro: "Ubuntu",
  httpBaseUrl: "http://127.0.0.1:4000",
  wsBaseUrl: "ws://127.0.0.1:4000",
};

let root: Root;
let rendered: ReadonlyArray<DesktopEnvironmentBootstrap>;
let readBootstraps: () => ReadonlyArray<DesktopEnvironmentBootstrap>;
let bridgeReads: number;
let notifyChange: (() => void) | undefined;

function BootstrapsProbe() {
  const bootstraps = useDesktopLocalBootstraps();
  useLayoutEffect(() => {
    rendered = bootstraps;
  }, [bootstraps]);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  // The probe renders no host nodes, but ReactDOM still needs an event target.
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  readBootstraps = () => [wsl];
  bridgeReads = 0;
  notifyChange = undefined;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", {
    document,
    HTMLIFrameElement: EventTarget,
    desktopBridge: {
      getLocalEnvironmentBootstraps: () => {
        bridgeReads++;
        return readBootstraps();
      },
      onLocalEnvironmentBootstrapsChange: (listener: () => void) => {
        notifyChange = listener;
        return () => {
          notifyChange = undefined;
        };
      },
    },
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("re-reads on desktop change events instead of polling", async () => {
  await act(() => root.render(<BootstrapsProbe />));
  expect(rendered).toEqual([wsl]);

  const readsAfterMount = bridgeReads;
  await act(() => vi.advanceTimersByTime(60_000));
  expect(bridgeReads).toBe(readsAfterMount);

  const moved = { ...wsl, httpBaseUrl: "http://127.0.0.1:4001" };
  readBootstraps = () => [moved];
  await act(() => notifyChange?.());
  expect(rendered).toEqual([moved]);

  // A failed read keeps the last snapshot; a successful empty read clears it.
  readBootstraps = () => {
    throw new Error("IPC unavailable");
  };
  await act(() => notifyChange?.());
  expect(rendered).toEqual([moved]);
  readBootstraps = () => [];
  await act(() => notifyChange?.());
  expect(rendered).toEqual([]);

  await act(() => root.unmount());
  expect(notifyChange).toBeUndefined();
});

it("polls a desktop shell that predates the change event", async () => {
  const { onLocalEnvironmentBootstrapsChange: _, ...legacyBridge } = (
    window as unknown as { desktopBridge: Record<string, unknown> }
  ).desktopBridge;
  vi.stubGlobal("window", { ...window, desktopBridge: legacyBridge });
  await act(() => root.render(<BootstrapsProbe />));
  expect(rendered).toEqual([wsl]);

  const moved = { ...wsl, httpBaseUrl: "http://127.0.0.1:4001" };
  readBootstraps = () => [moved];
  await act(() => vi.advanceTimersByTime(2_000));
  expect(rendered).toEqual([moved]);

  await act(() => root.unmount());
  const readsAfterUnmount = bridgeReads;
  await act(() => vi.advanceTimersByTime(10_000));
  expect(bridgeReads).toBe(readsAfterUnmount);
});
