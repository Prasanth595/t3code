// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { BrowserDocumentFrame, HtmlRenderDocument } from "./BrowserDocumentFrame";
import { useExternalBrowserMenu } from "~/browser/useExternalBrowserMenu";

const browser = vi.hoisted(() => ({
  choose: vi.fn(),
  open: vi.fn(),
  mint: vi.fn(),
  canRead: true,
  errors: vi.fn(),
}));
vi.mock("~/localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: browser.choose },
    shell: { openExternal: browser.open },
  }),
}));
vi.mock("~/state/assets", () => ({ assetEnvironment: { createUrl: {} } }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => browser.mint }));
vi.mock("~/state/session", () => ({
  readPreparedConnection: () => ({ httpBaseUrl: "https://source.test" }),
  readEnvironmentScope: () => browser.canRead,
}));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("~/lib/openPullRequestLink", () => ({ useOpenChangeRequestLink: () => vi.fn() }));
vi.mock("~/state/server", () => ({
  primaryServerKeybindingsAtom: Atom.make([]),
  serverEnvironment: { configValueAtom: () => Atom.make(null) },
}));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (input: unknown) => input,
  toastManager: { add: browser.errors },
}));

vi.mock("~/hooks/useHtmlRenderTheme", () => ({
  useHtmlRenderTheme: () => ({ appearance: "dark", variables: {} }),
}));
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const environmentId = EnvironmentId.make("source");
const resource = {
  _tag: "media-file" as const,
  threadId: ThreadId.make("thread"),
  path: "/exports/report.html",
};
function RemoteDocument({ pdf }: { pdf: boolean }) {
  const documentResource = { ...resource, path: pdf ? "/exports/report.pdf" : resource.path };
  const showMenu = useExternalBrowserMenu(environmentId, documentResource);
  return (
    <BrowserDocumentFrame
      src={`https://source.test/api/assets/expired/report.${pdf ? "pdf" : "html"}`}
      title="Report"
      pdf={pdf}
      onContextMenuRequest={showMenu}
    />
  );
}

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  "reauthorizes a native document selection with PDF=%s and grant revocation=%s",
  async (pdf, revoke) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("desktopBridge", {});
    browser.canRead = true;
    browser.choose.mockReset();
    browser.open.mockReset().mockResolvedValue(undefined);
    browser.errors.mockReset();
    browser.mint.mockReset().mockImplementation(async () => {
      if (revoke) browser.canRead = false;
      return AsyncResult.success({
        relativeUrl: `/api/assets/fresh/report.${pdf ? "pdf" : "html"}`,
        expiresAt: 1,
      });
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RemoteDocument pdf={pdf} />));
    const frame = container.querySelector("iframe")!;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 150, 300, 200));
    frame.focus();
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: { jsonrpc: "2.0", method: "t3/open-asset-externally", params: { x: 120, y: 180 } },
        }),
      );
    });
    expect(browser.choose).not.toHaveBeenCalled();
    expect(browser.mint).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { resource: { ...resource, path: pdf ? "/exports/report.pdf" : resource.path } },
    });
    if (revoke) {
      expect(browser.open).not.toHaveBeenCalled();
      expect(browser.errors).toHaveBeenCalledWith(
        expect.objectContaining({ description: "This connection cannot read host files." }),
      );
    } else {
      expect(browser.open).toHaveBeenCalledExactlyOnceWith(
        `https://source.test/api/assets/fresh/report.${pdf ? "pdf" : "html"}`,
      );
      expect(browser.errors).not.toHaveBeenCalled();
    }
  },
);
it("anchors a focused HTML frame's menu to the host and ignores foreign frames and out-of-bounds positions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onContextMenuRequest = vi.fn();
  await act(async () =>
    root!.render(
      <HtmlRenderDocument
        src="https://host.test/page.html"
        title="Report"
        onContextMenuRequest={onContextMenuRequest}
      />,
    ),
  );
  const frame = container.querySelector("iframe")!;
  Object.defineProperty(frame, "clientWidth", { value: 300 });
  Object.defineProperty(frame, "clientHeight", { value: 200 });
  vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 150, 300, 200));
  frame.focus();
  const send = (source: Window | null, x: number, y: number) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source,
        data: { jsonrpc: "2.0", method: "t3/context-menu", params: { x, y } },
      }),
    );
  send(frame.contentWindow, 25, 35);
  expect(onContextMenuRequest).toHaveBeenCalledWith({ x: 125, y: 185 });
  send(window, 25, 35);
  send(frame.contentWindow, 301, 35);
  frame.blur();
  send(frame.contentWindow, 25, 35);
  expect(onContextMenuRequest).toHaveBeenCalledOnce();
});
