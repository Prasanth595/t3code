import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
  type PreviewEvent,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
}));

// Every preview event of the primary environment, for any thread.
const primary = vi.hoisted(() => ({
  environmentId: "host-primary",
  events: null as unknown as Atom.Writable<AsyncResult.AsyncResult<PreviewEvent>>,
}));

vi.mock(import("~/state/primaryEnvironment"), async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make(primary.environmentId as EnvironmentId) };
});

vi.mock(import("~/state/preview"), async (original) => {
  const actual = await original();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  primary.events = Atom.make<AsyncResult.AsyncResult<PreviewEvent>>(AsyncResult.initial());
  return {
    ...actual,
    previewEnvironment: {
      ...actual.previewEnvironment,
      events: () => primary.events,
      list: () => Atom.make(AsyncResult.initial()),
    } as never,
  };
});

vi.mock(import("~/env"), async (original) => ({ ...(await original()), isElectron: true }));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

vi.mock(import("~/localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    ensureLocalApi: () => ({ ...actual.ensureLocalApi(), persistence: mocks as never }),
  };
});

// The Electron desktop bridge; a browser has none.
vi.mock(import("~/components/preview/previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    getPreviewConfig: mocks.getPreviewConfig,
  } as unknown as DesktopPreviewBridge,
}));

vi.mock(import("~/components/preview/usePreviewBridge"), async (original) => ({
  ...(await original()),
  usePreviewBridge: () => undefined,
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { reconcilePreviewServerSessions, resetPreviewStateForTests } from "~/previewStateStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { ElectronBrowserHost } from "./ElectronBrowserHost";

const threadRef = scopeThreadRef(
  EnvironmentId.make("host-webview-order"),
  ThreadId.make("thread-webview-order"),
);

const snapshot = (tabId: string, updatedAt: string): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Success", url: `https://example.com/${tabId}`, title: tabId },
  canGoBack: false,
  canGoForward: false,
  updatedAt,
});

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  __resetClientSettingsPersistenceForTests();
  mocks.getClientSettings.mockReset().mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset().mockResolvedValue(undefined);
  mocks.closeTab.mockReset().mockResolvedValue(undefined);
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-default",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  vi.useFakeTimers();
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  resetPreviewStateForTests();
  __resetClientSettingsPersistenceForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ElectronBrowserHost", () => {
  it("never moves a tab's webview when the server reorders tabs by last update", async () => {
    reconcilePreviewServerSessions(threadRef, {
      sessions: [
        snapshot("tab_7", "2026-01-01T00:00:01.000Z"),
        snapshot("tab_8", "2026-01-01T00:00:02.000Z"),
      ],
      serverEpoch: "server-a",
      revision: 1,
    });
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <AppAtomRegistryProvider>
          <ElectronBrowserHost />
        </AppAtomRegistryProvider>,
      );
      await ensureClientSettingsHydrated();
    });

    const host = container.querySelector("[data-electron-browser-host]")!;
    const webviews = () => [...host.querySelectorAll("webview")];
    const before = webviews();
    expect(before.map((node) => node.getAttribute("data-preview-server-tab")).toSorted()).toEqual([
      "tab_7",
      "tab_8",
    ]);

    // Electron destroys a webview's guest when its element leaves the DOM, so a reorder that
    // detaches and re-inserts the element blanks the tab.
    const detached: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) detached.push(...record.removedNodes);
    });
    observer.observe(host, { childList: true, subtree: true });

    await act(async () => {
      reconcilePreviewServerSessions(threadRef, {
        sessions: [
          snapshot("tab_8", "2026-01-01T00:00:02.000Z"),
          snapshot("tab_7", "2026-01-01T00:00:03.000Z"),
        ],
        serverEpoch: "server-a",
        revision: 2,
      });
    });
    observer.takeRecords().forEach((record) => detached.push(...record.removedNodes));
    observer.disconnect();

    expect(detached).toEqual([]);
    const after = webviews();
    expect(after).toHaveLength(2);
    expect(after.every((node, index) => node.isSameNode(before[index]!))).toBe(true);
  });

  it("hosts a server tab an agent opens in a thread the user is not viewing", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <AppAtomRegistryProvider>
          <ElectronBrowserHost />
        </AppAtomRegistryProvider>,
      );
      await ensureClientSettingsHydrated();
    });

    const backgroundThreadId = ThreadId.make("thread-agent-background");
    await act(async () => {
      appAtomRegistry.set(
        primary.events,
        AsyncResult.success({
          type: "opened",
          threadId: backgroundThreadId,
          tabId: "tab_1",
          createdAt: "2026-01-01T00:00:00.000Z",
          serverEpoch: "server-a",
          revision: 1,
          snapshot: {
            threadId: backgroundThreadId,
            tabId: "tab_1",
            runtime: "server",
            automationOwner: "agent-session",
            navStatus: { _tag: "Loading", url: "https://example.com/", title: "Example" },
            canGoBack: false,
            canGoForward: false,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        } as PreviewEvent),
      );
    });

    const webviews = [...container.querySelectorAll("[data-electron-browser-host] webview")];
    expect(webviews.map((node) => node.getAttribute("data-preview-server-tab"))).toEqual(["tab_1"]);
  });
});
