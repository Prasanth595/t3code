import * as NodeModule from "node:module";
import { act, createElement, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { ThreadMcpApp } from "./McpAppWebView";
import { HtmlRenderWebView } from "./HtmlRenderWebView";
import { ThreadMediaVisibleContext } from "./thread-media-visibility";

const native = vi.hoisted(() => ({
  OS: "android",
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
    navigate: vi.fn(),
  }),
}));
vi.mock("react-native-webview", () => ({
  WebView: () => {
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
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: vi.fn() }));
vi.mock("../../state/assets", () => ({
  useAssetUrlState: (environmentId: unknown) =>
    environmentId === null
      ? { _tag: "Loading" }
      : { _tag: "Success", url: "https://example.test/app", expiresAt: Number.MAX_SAFE_INTEGER },
  useRefreshAssetUrl: () => async () => null,
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
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "test" } } }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("../../lib/attachmentDownload", () => ({ shareGeneratedAttachment: vi.fn() }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "test-id" }));
vi.mock("../../state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../../state/mcpApps", () => ({ mcpAppEnvironment: {} }));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { turnItem: () => null },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/thread-outbox", () => ({ enqueueThreadOutboxMessage: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: {} }),
}));
const { createRoot } = NodeModule.createRequire(import.meta.url)("react-dom/client") as {
  createRoot(container: Element): { render(children: ReactNode): void; unmount(): void };
};
let root: ReturnType<typeof createRoot>;
const render = (visible = true, nested = true) =>
  act(() =>
    root.render(
      createElement(
        ThreadMediaVisibleContext,
        { value: visible },
        createElement(HtmlRenderWebView, {
          uri: "https://example.test/page",
          title: "Page",
          nested,
        }),
      ),
    ),
  );
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
  root = createRoot(container as unknown as Element);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("destroys hidden Android page runtimes and recreates one on return", async () => {
  await render();
  expect(native.pages).toBe(1);
  await act(() => {
    native.state = "background";
    native.listeners.forEach((listener) => listener());
  });
  expect(native.pages).toBe(0);
  await act(() => {
    native.state = "active";
    native.listeners.forEach((listener) => listener());
  });
  expect(native.pages).toBe(1);
  await render(false);
  expect(native.pages).toBe(0);
  await render();
  native.focused = false;
  await render();
  expect(native.pages).toBe(0);
  native.focused = true;
  await render();
  expect(native.pages).toBe(1);
  expect(native.starts).toBe(4);
});
it("keeps a focused full-screen page independent of feed row visibility", async () => {
  await render(false, false);
  expect(native.pages).toBe(1);
  native.focused = false;
  await render(false, false);
  expect(native.pages).toBe(0);
});

it("unloads and restores an inline MCP document across visibility changes", async () => {
  const props = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    conversationThreadId: ThreadId.make("thread"),
    itemId: TurnItemId.make("item"),
    revision: "1",
    width: 320,
    app: {
      attachmentId: "attachment",
      server: "example",
      tool: "view",
      resourceUri: "ui://example",
    },
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
  await renderApp(true);
  expect(native.pages).toBe(1);
  await renderApp(false);
  expect(native.pages).toBe(0);
  await renderApp(true);
  expect(native.pages).toBe(1);
  await act(() => {
    native.state = "background";
    native.listeners.forEach((listener) => listener());
  });
  expect(native.pages).toBe(0);
  await act(() => {
    native.state = "active";
    native.listeners.forEach((listener) => listener());
  });
  expect(native.pages).toBe(1);
  expect(native.starts).toBe(3);
});
