import { utils } from "xlsx";
import { expect, it, vi } from "vite-plus/test";
import type { SpreadsheetRequest, SpreadsheetResponse } from "./spreadsheetPreviewModel";

const { readSheet } = vi.hoisted(() => ({ readSheet: vi.fn() }));
vi.mock("./spreadsheetArchive", () => ({
  openSpreadsheetDocument: async () => ({
    sheets: ["First", "Slow", "Skipped", "Last"],
    readSheet,
  }),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("coalesces rapid switches without inflating multiple worksheets concurrently", async () => {
  let listener!: (event: { data: SpreadsheetRequest }) => void;
  const first = deferred<SpreadsheetResponse>();
  const last = deferred<SpreadsheetResponse>();
  const started = deferred<void>();
  const resume = deferred<void>();
  const posts: SpreadsheetResponse[] = [];
  readSheet.mockImplementation(async (name: string) => {
    if (name === "Slow") {
      started.resolve();
      await resume.promise;
    }
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, utils.aoa_to_sheet([[name]]), name);
    return { workbook, limited: false };
  });
  vi.stubGlobal("self", {
    addEventListener: (_type: string, callback: typeof listener) => {
      listener = callback;
    },
    postMessage: (response: SpreadsheetResponse) => {
      posts.push(response);
      if (response.id === 1) first.resolve(response);
      if (response.id === 4) last.resolve(response);
    },
  });
  try {
    vi.resetModules();
    await import("./spreadsheetPreview.worker");
    listener({ data: { type: "load", id: 1, bytes: new Uint8Array() } });
    await first.promise;
    listener({ data: { type: "sheet", id: 2, name: "Slow" } });
    await started.promise;
    listener({ data: { type: "sheet", id: 3, name: "Skipped" } });
    listener({ data: { type: "sheet", id: 4, name: "Last" } });
    resume.resolve();
    expect(await last.promise).toMatchObject({ id: 4, table: { name: "Last" } });
    expect(readSheet.mock.calls.map(([name]) => name)).toEqual(["First", "Slow", "Last"]);
    expect(readSheet.mock.calls[1]![1].aborted).toBe(true);
    expect(posts.map((p) => p.id)).toEqual([1, 4]);
  } finally {
    vi.unstubAllGlobals();
  }
});
