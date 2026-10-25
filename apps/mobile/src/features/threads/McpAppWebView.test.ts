import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { act, createElement, useEffect, type ReactNode, type ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { ThreadMcpApp } from "./McpAppWebView";
import { ThreadMediaVisibleContext } from "./thread-media-visibility";

import type { WebView, WebViewMessageEvent } from "react-native-webview";
import type { McpAppHost } from "@t3tools/client-runtime/mcp-apps";
import type { AssetUrlState } from "@t3tools/client-runtime/state/assets";

type ToolInfo = { _tag: "Success"; value: { callable: boolean; readOnly: boolean } };
type WebProps = ComponentProps<typeof WebView>;
const native = vi.hoisted(() => ({
  nextId: 0,
  OS: "android",
  webProps: null as WebProps | null,
  asset: {
    _tag: "Success",
    url: "https://example.test/old",
    expiresAt: Number.MAX_SAFE_INTEGER,
  } as AssetUrlState,
  hosts: [] as McpAppHost[],
  command: vi.fn(async () => ({ _tag: "Success", value: { content: [] } })),
  info: vi.fn(async (): Promise<ToolInfo> => ({
    _tag: "Success",
    value: { callable: true, readOnly: true },
  })),
  refresh: vi.fn<() => Promise<string | null>>(),
  approve: null as (() => void) | null,
  external: vi.fn(async () => true),
  enqueue: vi.fn(async () => {}),
  share: vi.fn(async () => true),
  navigate: vi.fn(),
  state: "active",
  focused: true,
  pages: 0,
  starts: 0,
  listeners: new Set<() => void>(),
}));
vi.mock("react-native", () => ({
  Platform: native,
  View: ({ children }: { children: ReactNode }) => children,
  AppState: {
    get currentState() {
      return native.state;
    },
    addEventListener: (_event: string, listener: () => void) => {
      native.listeners.add(listener);
      return { remove: () => native.listeners.delete(listener) };
    },
  },
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => native.focused,
  useNavigation: () => ({
    isFocused: () => native.focused,
    addListener: () => () => {},
    navigate: native.navigate,
  }),
}));
vi.mock("react-native-webview", () => ({
  WebView: (props: WebProps) => {
    native.webProps = props;
    useEffect(() => {
      native.pages++;
      native.starts++;
      return () => {
        native.pages--;
      };
    }, []);
    return null;
  },
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: () => null }));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: native.external }));
vi.mock("../../state/assets", () => ({
  useAssetUrlState: (environmentId: unknown) =>
    environmentId === null ? { _tag: "Loading" } : native.asset,
  useRefreshAssetUrl: () => native.refresh,
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeId: "default",
    themeAppearance: "dark",
    themeVariables: {},
  }),
}));
vi.mock("../../lib/htmlRenderTheme", () => ({
  mobileHtmlRenderTheme: () => ({ appearance: "dark", variables: {} }),
}));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/Dialog", () => ({
  alert: (_title: string, _message: string, buttons: { onPress: () => void }[]) => {
    native.approve = buttons[1]!.onPress;
  },
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "test" } } }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("../../lib/attachmentDownload", () => ({ shareGeneratedAttachment: native.share }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => `test-id-${native.nextId++}` }));
vi.mock("../../state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../../state/mcpApps", () => ({
  mcpAppEnvironment: { toolInfo: "toolInfo", callTool: "callTool" },
}));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { turnItem: () => null },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/thread-outbox", () => ({ enqueueThreadOutboxMessage: native.enqueue }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "toolInfo" ? native.info : native.command),
}));
const { createRoot } = NodeModule.createRequire(import.meta.url)("react-dom/client") as {
  createRoot(container: Element): { render(children: ReactNode): void; unmount(): void };
};
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(native, { OS: "android", state: "active", focused: true, pages: 0, starts: 0 });
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.hosts = [];
  native.webProps = null;
  native.command.mockClear();
  native.info
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { callable: true, readOnly: true } });
  native.asset = {
    _tag: "Success",
    url: "https://example.test/old",
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  native.refresh.mockReset().mockResolvedValue(null);
  native.approve = null;
  native.external.mockClear();
  native.enqueue.mockClear();
  native.share.mockClear();
  native.navigate.mockClear();
  root = createRoot(container as unknown as Element);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

vi.mock("@t3tools/client-runtime/mcp-apps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime/mcp-apps")>();
  return {
    ...actual,
    makeMcpAppHost: (options: Parameters<typeof actual.makeMcpAppHost>[0]) => {
      const host = actual.makeMcpAppHost(options);
      native.hosts.push(host);
      return host;
    },
  };
});
const props = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  conversationThreadId: ThreadId.make("thread"),
  itemId: TurnItemId.make("item"),
  revision: "1",
  width: 320,
  app: { attachmentId: "attachment", server: "example", tool: "view", resourceUri: "ui://example" },
};
const renderApp = (visible: boolean) =>
  act(() =>
    root.render(
      createElement(
        ThreadMediaVisibleContext,
        { value: visible },
        createElement(ThreadMcpApp, props),
      ),
    ),
  );

it("must not dispatch a request from a document disposed during tool-info lookup", async () => {
  await renderApp(true);
  const originalHost = native.hosts.at(-1)!;
  const lookup = Promise.withResolvers<ToolInfo>();
  native.info.mockImplementationOnce(() => lookup.promise);
  await act(() =>
    originalHost.receive({
      jsonrpc: "2.0",
      id: 91,
      method: "tools/call",
      params: { name: "read", arguments: { oldDocument: true } },
    }),
  );
  await renderApp(false);
  expect(native.pages).toBe(0);
  await renderApp(true);
  expect(native.hosts.at(-1)).not.toBe(originalHost);
  await act(async () => {
    lookup.resolve({ _tag: "Success", value: { callable: true, readOnly: true } });
    await lookup.promise;
  });
  expect(native.command).not.toHaveBeenCalled();
});

it("must not freeze a reloaded document on an expired stale-while-revalidate URL", async () => {
  await renderApp(true);
  await renderApp(false);
  native.asset = { _tag: "Success", url: "https://example.test/expired", expiresAt: 0 };
  await renderApp(true);
  // The asset atom returns its cached success while the reconnection refetch runs.
  native.asset = {
    _tag: "Success",
    url: "https://example.test/fresh",
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  await renderApp(true);
  expect((native.webProps!.source as { html: string }).html).toContain(
    "https://example.test/fresh",
  );
});

it("lets a current document finish its tool lookup", async () => {
  await renderApp(true);
  const lookup = Promise.withResolvers<ToolInfo>();
  native.info.mockImplementationOnce(() => lookup.promise);
  await act(() =>
    native.hosts
      .at(-1)!
      .receive({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read" } }),
  );
  await act(async () => {
    lookup.resolve({ _tag: "Success", value: { callable: true, readOnly: true } });
    await lookup.promise;
  });
  expect(native.command).toHaveBeenCalledOnce();
});

it.each([
  { method: "tools/call", params: { name: "write" }, dispatched: () => native.command },
  {
    method: "ui/open-link",
    params: { url: "https://example.test" },
    dispatched: () => native.external,
  },
  {
    method: "ui/message",
    params: { role: "user", content: [{ type: "text", text: "do work" }] },
    dispatched: () => native.enqueue,
  },
  {
    method: "ui/download-file",
    params: {
      contents: [{ type: "resource", resource: { uri: "file:///sample.txt", text: "hello" } }],
    },
    dispatched: () => native.share,
  },
])(
  "does not complete $method approval for a disposed document",
  async ({ method, params, dispatched }) => {
    await renderApp(true);
    native.info.mockResolvedValue({ _tag: "Success", value: { callable: true, readOnly: false } });
    await act(() => native.hosts.at(-1)!.receive({ jsonrpc: "2.0", id: 2, method, params }));
    expect(native.approve).not.toBeNull();
    const approve = native.approve!;
    await renderApp(false);
    await renderApp(true);
    await act(() => approve());
    expect(dispatched()).not.toHaveBeenCalled();
  },
);

it("does not navigate after a disposed document finishes fullscreen teardown", async () => {
  await renderApp(true);
  const teardown = Promise.withResolvers<void>();
  vi.spyOn(native.hosts.at(-1)!, "teardown").mockReturnValue(teardown.promise);
  await act(() =>
    native.webProps!.onMessage!({
      nativeEvent: {
        data: JSON.stringify({
          secret: JSON.parse(
            (native.webProps!.source as { html: string }).html.match(/secret=("[^"]+")/)![1]!,
          ),
          active: true,
          message: {
            jsonrpc: "2.0",
            id: 3,
            method: "ui/request-display-mode",
            params: { mode: "fullscreen" },
          },
        }),
      },
    } as WebViewMessageEvent),
  );
  await renderApp(false);
  await renderApp(true);
  await act(async () => {
    teardown.resolve();
    await teardown.promise;
  });
  expect(native.navigate).not.toHaveBeenCalled();
  expect(native.pages).toBe(1);
});

const html = () => (native.webProps!.source as { html: string }).html;
const httpError = (
  statusCode: number,
  url = JSON.parse(html().match(/frame.src=("[^"\n]+")/)![1]!),
) =>
  act(() =>
    native.webProps!.onHttpError!({ nativeEvent: { statusCode, url } } as Parameters<
      NonNullable<WebProps["onHttpError"]>
    >[0]),
  );

it("explicitly refreshes an expired URL before mounting the resumed document", async () => {
  await renderApp(true);
  await renderApp(false);
  native.asset = { _tag: "Success", url: "https://example.test/expired", expiresAt: 0 };
  const refresh = Promise.withResolvers<string | null>();
  native.refresh.mockReturnValueOnce(refresh.promise);
  await renderApp(true);
  expect(native.pages).toBe(0);
  expect(native.refresh).toHaveBeenCalledOnce();
  await act(async () => {
    refresh.resolve("https://example.test/refreshed");
    await refresh.promise;
  });
  expect(native.pages).toBe(1);
  expect(html()).toContain("https://example.test/refreshed");
});

it.each([401, 403, 404])("refreshes a rejected URL once after HTTP %s", async (status) => {
  await renderApp(true);
  native.refresh.mockResolvedValue("https://example.test/refreshed");
  await httpError(status);
  expect(native.refresh).toHaveBeenCalledOnce();
  expect(html()).toContain("https://example.test/refreshed");
  expect(native.pages).toBe(1);
  await httpError(status);
  expect(native.refresh).toHaveBeenCalledOnce();
  expect(native.pages).toBe(0);
});

it("does not retry a non-authentication HTTP failure", async () => {
  await renderApp(true);
  await httpError(500);
  expect(native.refresh).not.toHaveBeenCalled();
  expect(native.pages).toBe(0);
});

it("keeps a live document mounted when its cached URL refreshes", async () => {
  await renderApp(true);
  const host = native.hosts.at(-1);
  const original = html();
  native.asset = {
    _tag: "Success",
    url: "https://example.test/new-token",
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  await renderApp(true);
  expect(html()).toBe(original);
  expect(native.hosts.at(-1)).toBe(host);
  expect(native.starts).toBe(1);
});

it("ignores a stale URL refresh after a replacement document mounts", async () => {
  await renderApp(true);
  const refresh = Promise.withResolvers<string | null>();
  native.refresh.mockReturnValueOnce(refresh.promise);
  await httpError(401);
  await renderApp(false);
  native.asset = {
    _tag: "Success",
    url: "https://example.test/current",
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  await renderApp(true);
  const current = html();
  await act(async () => {
    refresh.resolve("https://example.test/obsolete");
    await refresh.promise;
  });
  expect(html()).toBe(current);
  expect(native.pages).toBe(1);
});

it("refreshes an expired URL when restarting a terminated renderer", async () => {
  await renderApp(true);
  native.asset = { _tag: "Success", url: "https://example.test/expired", expiresAt: 0 };
  await renderApp(true);
  native.refresh.mockResolvedValue("https://example.test/restarted");
  await act(() =>
    native.webProps!.onRenderProcessGone!({ nativeEvent: { didCrash: true } } as Parameters<
      NonNullable<WebProps["onRenderProcessGone"]>
    >[0]),
  );
  expect(html()).toContain("https://example.test/restarted");
  expect(native.pages).toBe(1);
});

it("ignores events delivered by a replaced native page", async () => {
  await renderApp(true);
  const previous = native.webProps!;
  const secret = JSON.parse(html().match(/secret=("[^"]+")/)![1]!);
  await renderApp(false);
  await renderApp(true);
  await act(() =>
    previous.onMessage!({
      nativeEvent: {
        data: JSON.stringify({
          secret,
          active: true,
          message: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read" } },
        }),
      },
    } as WebViewMessageEvent),
  );
  expect(native.command).not.toHaveBeenCalled();
  await act(() => previous.onError!({} as Parameters<NonNullable<WebProps["onError"]>>[0]));
  expect(native.pages).toBe(1);
});

it("does not close a replacement page after old teardown completes", async () => {
  await renderApp(true);
  const original = native.hosts.at(-1)!;
  const teardown = Promise.withResolvers<void>();
  vi.spyOn(original, "teardown").mockReturnValue(teardown.promise);
  await act(() =>
    original.receive({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" }),
  );
  await renderApp(false);
  await renderApp(true);
  await act(async () => {
    teardown.resolve();
    await teardown.promise;
  });
  expect(native.pages).toBe(1);
});

// Execute the shipped outer-page relay: Android does not forward iframe HTTP
// errors to onHttpError, so recovery must work without invoking that callback.
function startOuterPage() {
  vi.useFakeTimers();
  const webProps = native.webProps!;
  const frame = new EventTarget() as EventTarget & { contentWindow: object; src: string };
  frame.contentWindow = {};
  const page = new EventTarget() as EventTarget & { ReactNativeWebView: object };
  page.ReactNativeWebView = {
    postMessage: (data: string) =>
      webProps.onMessage!({ nativeEvent: { data } } as WebViewMessageEvent),
  };
  NodeVM.runInNewContext(html().match(/<script>([\s\S]*)<\/script>/)![1]!, {
    window: page,
    document: { getElementById: () => frame },
    navigator: {},
    setTimeout,
    clearTimeout,
  });
  return {
    load: () => frame.dispatchEvent(new Event("load")),
    initialized: (source = frame.contentWindow) =>
      page.dispatchEvent(
        Object.assign(new Event("message"), {
          source,
          data: { jsonrpc: "2.0", method: "ui/notifications/initialized" },
        }),
      ),
  };
}

it.each(["https://example.test/old", "https://example.test/refreshed"])(
  "retries a failed iframe once with refreshed URL %s, then stops after a second failure",
  async (refreshedUrl) => {
    await renderApp(true);
    const originalHtml = html();
    const originalHost = native.hosts.at(-1);
    native.refresh.mockResolvedValue(refreshedUrl);
    const page = startOuterPage();
    await act(() => page.load());
    await act(() => vi.advanceTimersByTime(30_000));
    expect(native.refresh).toHaveBeenCalledOnce();
    expect(native.pages).toBe(1);
    expect(native.starts).toBe(2);
    expect(html()).toContain(refreshedUrl);
    expect(html()).not.toBe(originalHtml);
    expect(native.hosts.at(-1)).not.toBe(originalHost);
    startOuterPage();
    await act(() => vi.advanceTimersByTime(30_000));
    expect(native.refresh).toHaveBeenCalledOnce();
    expect(native.pages).toBe(0);
  },
);

it("cancels initial-load recovery when the app frame completes its handshake", async () => {
  await renderApp(true);
  const page = startOuterPage();
  await act(() => page.initialized());
  await act(() => vi.advanceTimersByTime(30_000));
  expect(native.refresh).not.toHaveBeenCalled();
  expect(native.pages).toBe(1);
});

it("does not let a nested frame cancel initial-load recovery", async () => {
  await renderApp(true);
  native.refresh.mockResolvedValue("https://example.test/refreshed");
  const page = startOuterPage();
  await act(() => page.initialized({}));
  await act(() => vi.advanceTimersByTime(30_000));
  expect(native.refresh).toHaveBeenCalledOnce();
});

it("ignores a disposed iframe's handshake timeout and cancels its pending refresh", async () => {
  await renderApp(true);
  const page = startOuterPage();
  await renderApp(false);
  await renderApp(true);
  await act(() => page.load());
  await act(() => vi.advanceTimersByTime(30_000));
  expect(native.refresh).not.toHaveBeenCalled();
  const refresh = Promise.withResolvers<string | null>();
  native.refresh.mockReturnValueOnce(refresh.promise);
  startOuterPage();
  await act(() => vi.advanceTimersByTime(30_000));
  expect(native.refresh).toHaveBeenCalledOnce();
  await renderApp(false);
  await act(async () => {
    refresh.resolve("https://example.test/obsolete");
    await refresh.promise;
  });
  expect(native.pages).toBe(0);
});

it("ignores HTTP failures from nested subresources", async () => {
  await renderApp(true);
  await httpError(404, "https://example.test/icon.png");
  expect(native.refresh).not.toHaveBeenCalled();
  expect(native.pages).toBe(1);
});
