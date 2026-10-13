import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import SpreadsheetPreview from "./SpreadsheetPreview";
import { spreadsheetTable, spreadsheetWindow } from "./spreadsheetDocument";
import { utils } from "xlsx";
import {
  SPREADSHEET_PREVIEW_TIMEOUT_MS,
  type SpreadsheetRequest,
  type SpreadsheetResponse,
} from "./spreadsheetPreviewModel";

vi.mock("~/components/ui/button", () => ({
  Button: (props: Record<string, unknown>) => <button {...props} />,
}));
vi.mock("./fileSurfaceChrome", () => ({
  FileSurfaceFailure: ({ message, onRetry }: { message: string; onRetry: () => void }) => (
    <button onClick={onRetry}>{message}</button>
  ),
  FileSurfaceLoading: () => <div>Loading</div>,
  FileSurfaceNotice: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

class FakeWorker {
  static current: FakeWorker;
  messages: SpreadsheetRequest[] = [];
  terminate = vi.fn();
  listeners = new Map<string, (event: { data: SpreadsheetResponse }) => void>();
  constructor() {
    FakeWorker.current = this;
  }
  addEventListener(type: string, listener: (event: { data: SpreadsheetResponse }) => void) {
    this.listeners.set(type, listener);
  }
  postMessage(message: SpreadsheetRequest) {
    this.messages.push(message);
  }
  respond(response: SpreadsheetResponse) {
    this.listeners.get("message")?.({ data: response });
  }
}
const wb = utils.book_new();
utils.book_append_sheet(
  wb,
  utils.aoa_to_sheet(Array.from({ length: 250 }, (_, r) => [`Row ${r + 1}`])),
  "Data",
);
utils.book_append_sheet(wb, utils.aoa_to_sheet([["Other sheet"]]), "Other");
const window = spreadsheetWindow(wb, "Data");
let renderer: ReactTestRenderer | undefined;
const response = (id: number, page = 0): SpreadsheetResponse => ({
  id,
  sheets: ["Data", "Other"],
  table: spreadsheetTable(window, page),
});
const render = async () => {
  await act(() => {
    renderer = create(
      <SpreadsheetPreview bytes={new Uint8Array([1])} name="test.xlsx" onRetry={() => {}} />,
    );
  });
  const worker = FakeWorker.current;
  await act(() => worker.respond(response(worker.messages[0]!.id)));
  return worker;
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Worker", FakeWorker);
  vi.useFakeTimers();
});
afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("spreadsheet lifecycle and pagination", () => {
  it("keeps the replacement worker's watchdog when an obsolete worker fails", async () => {
    const previous = await render();
    await act(() =>
      renderer!.update(
        <SpreadsheetPreview
          bytes={new Uint8Array([2])}
          name="replacement.xlsx"
          onRetry={() => {}}
        />,
      ),
    );
    const current = FakeWorker.current;
    await act(() =>
      previous.listeners.get("error")!({ data: { id: -1, error: "Obsolete error" } }),
    );
    expect(vi.getTimerCount()).toBe(1);
    await act(() => vi.advanceTimersByTime(SPREADSHEET_PREVIEW_TIMEOUT_MS));
    expect(current.terminate).toHaveBeenCalledOnce();
    expect(JSON.stringify(renderer!.toJSON())).toContain("too long to preview");
  });
  it("displays 100 rows and changes to the next page with preserved coordinates", async () => {
    const worker = await render();
    expect(renderer!.root.findAllByType("td")).toHaveLength(100);
    expect(renderer!.root.findAllByType("td")[0]!.children).toEqual(["Row 1"]);
    await act(() =>
      renderer!.root
        .findAllByType("button")
        .find((b) => b.children.includes("Next page"))!
        .props.onClick(),
    );
    const request = worker.messages.at(-1)!;
    expect(request).toMatchObject({ type: "page", name: "Data", page: 1 });
    await act(() => worker.respond(response(request.id, 1)));
    expect(renderer!.root.findAllByType("td")).toHaveLength(100);
    expect(renderer!.root.findAllByType("td")[0]!.children).toEqual(["Row 101"]);
  });
  it("ignores stale pages and errors after changing the worksheet", async () => {
    const worker = await render();
    await act(() =>
      renderer!.root
        .findAllByType("button")
        .find((b) => b.children.includes("Next page"))!
        .props.onClick(),
    );
    const old = worker.messages.at(-1)!;
    await act(() =>
      renderer!.root.findByType("select").props.onChange({ target: { value: "Other" } }),
    );
    const next = worker.messages.at(-1)!;
    await act(() => worker.respond({ id: old.id, error: "Stale error" }));
    await act(() =>
      worker.respond({
        id: next.id,
        sheets: ["Data", "Other"],
        table: spreadsheetTable(spreadsheetWindow(wb, "Other")),
      }),
    );
    await act(() => worker.respond(response(old.id, 1)));
    expect(renderer!.root.findAllByType("td")[0]!.children).toEqual(["Other sheet"]);
    expect(renderer!.root.findByType("select").props.value).toBe("Other");
  });
  it("terminates a stalled worker and offers a recoverable failure", async () => {
    await act(() => {
      renderer = create(
        <SpreadsheetPreview bytes={new Uint8Array([1])} name="test.xlsx" onRetry={() => {}} />,
      );
    });
    const worker = FakeWorker.current;
    await act(() => vi.advanceTimersByTime(SPREADSHEET_PREVIEW_TIMEOUT_MS));
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(JSON.stringify(renderer!.toJSON())).toContain("too long to preview");
    await act(() => worker.respond(response(worker.messages[0]!.id)));
    expect(JSON.stringify(renderer!.toJSON())).toContain("too long to preview");
  });
  it("clears the watchdog and releases the worker when closed", async () => {
    const worker = await render();
    await act(() => renderer!.unmount());
    renderer = undefined;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
