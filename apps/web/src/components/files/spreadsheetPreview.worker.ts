/* oxlint-disable unicorn/require-post-message-target-origin -- This worker posts to its owner, with no Window target origin. */
import { openSpreadsheetDocument } from "./spreadsheetArchive";
import { spreadsheetWindow, spreadsheetTable } from "./spreadsheetDocument";
import {
  type SpreadsheetRequest,
  type SpreadsheetResponse,
  type SpreadsheetWindow,
} from "./spreadsheetPreviewModel";

let document: Awaited<ReturnType<typeof openSpreadsheetDocument>> | undefined;
let selected: SpreadsheetWindow | undefined;
let latestId = 0;
let pending: { request: SpreadsheetRequest; signal: AbortSignal } | undefined;
let running = false;
let controller: AbortController | undefined;
async function respond(request: SpreadsheetRequest, signal: AbortSignal) {
  try {
    if (request.type === "load") {
      selected = undefined;
      document = await openSpreadsheetDocument(request.bytes);
    }
    if (latestId !== request.id) return;
    const archive = document;
    if (!archive) throw new Error("This workbook is unavailable.");
    const name = request.type === "load" ? archive.sheets[0] : request.name;
    if (!name || !archive.sheets.includes(name)) throw new Error("This worksheet is unavailable.");
    if (request.type !== "page") {
      selected = undefined;
      const result = await archive.readSheet(name, signal);
      if (latestId !== request.id) return;
      selected = spreadsheetWindow(result.workbook, name, result.limited);
    }
    if (!selected || selected.name !== name) throw new Error("This worksheet is unavailable.");
    const result: SpreadsheetResponse = {
      id: request.id,
      sheets: archive.sheets,
      table: spreadsheetTable(selected, request.type === "page" ? request.page : 0),
    };
    self.postMessage(result);
  } catch (cause) {
    if (latestId !== request.id) return;
    const result: SpreadsheetResponse = {
      id: request.id,
      error: cause instanceof Error ? cause.message : "Could not read this workbook.",
    };
    self.postMessage(result);
  }
}
self.addEventListener("message", (event: MessageEvent<SpreadsheetRequest>) => {
  controller?.abort();
  controller = new AbortController();
  latestId = event.data.id;
  pending = { request: event.data, signal: controller.signal };
  if (running) return;
  running = true;
  // Coalesce rapid switches and keep only one XML inflation/materialization active at a time.
  void (async () => {
    try {
      while (pending) {
        const next = pending;
        pending = undefined;
        await respond(next.request, next.signal);
      }
    } finally {
      running = false;
    }
  })();
});
