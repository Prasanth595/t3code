// @vitest-environment jsdom

import * as NodeBuffer from "node:buffer";
import * as NodeURL from "node:url";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AttachmentFilePreview } from "./AttachmentFilePreview";
import { WorkspaceOfficePreview } from "./WorkspaceOfficePreview";
import {
  parseOfficeDocument,
  type OfficeWorkerRequest,
  type OfficeWorkerResponse,
} from "./officeDocumentParser";

const mocks = vi.hoisted(() => ({
  url: "https://environment.test/api/assets/signed/book.xlsx",
  refresh: vi.fn<() => Promise<string | null>>(),
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlRefresh: () => mocks.refresh,
  useAssetUrlState: () => ({ _tag: "Success", url: mocks.url }),
}));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({
  useWorkspaceMutationRefresh: () => undefined,
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => true,
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/components/ChatMarkdown", () => ({ default: () => null }));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/components/ui/button", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
}));
vi.mock("./fileSurfaceChrome", () => ({
  FILE_SURFACE_SUBHEADER_CLASS: "",
  FileSurfaceAction: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button aria-label={label} onClick={onPress} />
  ),
  FileSurfaceFailure: ({ message }: { message: string }) => <div role="alert">{message}</div>,
  FileSurfaceLoading: () => <div role="status">Loading</div>,
  FileSurfaceNotice: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

/** Only the browser worker transport is replaced: its request is parsed by the real decoder. */
class ParserWorker extends EventTarget {
  static posted: ((worker: ParserWorker) => void) | undefined;
  request: OfficeWorkerRequest | undefined;
  terminate = vi.fn();
  postMessage(request: OfficeWorkerRequest) {
    this.request = request;
    ParserWorker.posted?.(this);
  }
  finish() {
    const request = this.request;
    if (!request) throw new Error("Worker has no document request");
    const document = parseOfficeDocument(new Uint8Array(request.buffer), request.format);
    this.dispatchEvent(
      new MessageEvent<OfficeWorkerResponse>("message", {
        data: { id: request.id, ok: true, document },
      }),
    );
  }
}

function workbookBytes(bookType: "xlsx" | "biff8" = "xlsx", value = "ねこ / real workbook") {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Product", "Total"],
      [value, 1800],
    ]),
    "売上",
  );
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType, compression: true }));
}

const environmentId = EnvironmentId.make("test-environment");
const threadRef = { environmentId, threadId: ThreadId.make("test-thread") };
const nextWorker = () =>
  new Promise<ParserWorker>((resolve) => {
    ParserWorker.posted = resolve;
  });
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Worker", ParserWorker);
  // JSDOM does not implement Blob streaming or object URLs; retain Node's native byte APIs.
  vi.stubGlobal("Blob", NodeBuffer.Blob);
  vi.stubGlobal("URL", NodeURL.URL);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.url = "https://environment.test/api/assets/signed/book.xlsx";
  mocks.refresh.mockReset().mockImplementation(async () => mocks.url);
  ParserWorker.posted = undefined;
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:office-local");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(workbookBytes())),
  );
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const workspace = (name = "/workspace/book.xlsx", reloadRevision = 0) => (
  <WorkspaceOfficePreview
    environmentId={environmentId}
    threadRef={threadRef}
    draft={false}
    absolutePath={name}
    workspaceRoot="/workspace"
    format="xlsx"
    workspaceMutationId={null}
    reloadRevision={reloadRevision}
  />
);

describe("Office entry points with the real document client and parser", () => {
  it("reloads changed bytes on a manual revision even when the signed URL is unchanged", async () => {
    const firstPosted = nextWorker();
    await act(() => root.render(workspace()));
    const first = await firstPosted;
    await act(() => first.finish());
    expect(container.querySelector("tbody")?.textContent).toContain("ねこ / real workbook");
    vi.mocked(fetch).mockImplementation(
      async () => new Response(workbookBytes("xlsx", "updated value")),
    );
    const secondPosted = nextWorker();
    await act(() => root.render(workspace("/workspace/book.xlsx", 1)));
    const second = await secondPosted;
    await act(() => second.finish());
    expect(container.querySelector("tbody")?.textContent).toContain("updated value");
    expect(container.querySelector("tbody")?.textContent).not.toContain("ねこ / real workbook");
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
      mocks.url,
      `${mocks.url}?workspace-revision=%3A1`,
    ]);
  });

  it("loads a signed workspace asset and displays decoded cells", async () => {
    const posted = nextWorker();
    await act(() => root.render(workspace()));
    const worker = await posted;
    await act(() => worker.finish());
    expect(fetch).toHaveBeenCalledExactlyOnceWith(mocks.url, { signal: expect.any(AbortSignal) });
    expect(container.querySelector("table")?.getAttribute("aria-label")).toBe("売上 cell values");
    expect(container.querySelector("tbody")?.textContent).toContain("ねこ / real workbook1800");
    expect(container.textContent).toContain(
      "Values only; styles, charts, and formula recalculation",
    );
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("routes a text/plain xlsx attachment through signed binary loading rather than UTF-8 source", async () => {
    const posted = nextWorker();
    await act(() =>
      root.render(
        <AttachmentFilePreview
          name="captured.xlsx"
          mimeType="text/plain"
          sizeBytes={100}
          asset={{ environmentId, attachmentId: "captured-xlsx" }}
        />,
      ),
    );
    const worker = await posted;
    await act(() => worker.finish());
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(mocks.url, { signal: expect.any(AbortSignal) });
    expect(container.querySelector("td")?.textContent).toBe("Product");
    expect(container.querySelector("tbody")?.textContent).toContain("ねこ / real workbook1800");
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("reads real BIFF8 from a local Blob and releases its object URL when changing to legacy ppt fallback", async () => {
    const file = new Blob([workbookBytes("biff8")], { type: "application/vnd.ms-excel" });
    const posted = nextWorker();
    await act(() =>
      root.render(
        <AttachmentFilePreview
          name="local.xls"
          mimeType="application/vnd.ms-excel"
          sizeBytes={file.size}
          file={file}
        />,
      ),
    );
    const worker = await posted;
    await act(() => worker.finish());
    expect(container.querySelector("tbody")?.textContent).toContain("ねこ / real workbook1800");
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    const legacy = new Blob([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])]);
    await act(() =>
      root.render(
        <AttachmentFilePreview
          name="legacy.ppt"
          mimeType="application/vnd.ms-powerpoint"
          sizeBytes={legacy.size}
          file={legacy}
        />,
      ),
    );
    expect(container.textContent).toContain("No preview for this file");
    expect(container.textContent).toContain("Save it to open in an app that supports ppt files.");
    expect(container.querySelector("table")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:office-local");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates pending work on route replacement and unmount, ignoring a stale result", async () => {
    const firstPosted = nextWorker();
    await act(() => root.render(workspace("/workspace/first.xlsx")));
    const first = await firstPosted;
    mocks.url = "https://environment.test/api/assets/second/book.xlsx";
    const secondPosted = nextWorker();
    await act(() => root.render(workspace("/workspace/second.xlsx")));
    const second = await secondPosted;
    expect(first.terminate).toHaveBeenCalledOnce();
    await act(() => first.finish());
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("Loading");
    await act(() => root.render(null));
    expect(second.terminate).toHaveBeenCalledOnce();
    await act(() => second.finish());
    expect(container.textContent).toBe("");
  });
});
