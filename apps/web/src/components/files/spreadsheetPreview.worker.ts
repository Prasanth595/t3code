import type { WorkBook } from "xlsx";
import {
  readSpreadsheetDocument,
  spreadsheetTable,
  visibleSpreadsheetSheets,
} from "./spreadsheetDocument";
import { type SpreadsheetRequest, type SpreadsheetResponse } from "./spreadsheetPreviewModel";

let workbook: WorkBook | undefined;
let sheets: string[] = [];
self.addEventListener("message", (event: MessageEvent<SpreadsheetRequest>) => {
  let result: SpreadsheetResponse;
  try {
    if (event.data.type === "load") {
      workbook = readSpreadsheetDocument(event.data.bytes);
      sheets = visibleSpreadsheetSheets(workbook);
    }
    if (!workbook || sheets.length === 0)
      throw new Error("This workbook has no visible worksheets.");
    const name = event.data.type === "sheet" ? event.data.name : sheets[0];
    if (name === undefined || !sheets.includes(name))
      throw new Error("This worksheet is unavailable.");
    result = { sheets, table: spreadsheetTable(workbook, name) };
  } catch (cause) {
    result = { error: cause instanceof Error ? cause.message : "Could not read this workbook." };
  }
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A worker posts to its owner, with no Window target origin.
  self.postMessage(result);
});
