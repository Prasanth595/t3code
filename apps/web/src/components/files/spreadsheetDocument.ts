import { utils, type WorkBook } from "xlsx";
import {
  SPREADSHEET_PREVIEW_ROWS,
  SPREADSHEET_PREVIEW_COLUMNS,
  SPREADSHEET_PREVIEW_CELL_CHARACTERS,
  SPREADSHEET_PREVIEW_TEXT_CHARACTERS,
  SPREADSHEET_PREVIEW_PAYLOAD_BYTES,
  SPREADSHEET_PREVIEW_PAGE_ROWS,
  type SpreadsheetTable,
  type SpreadsheetWindow,
} from "./spreadsheetPreviewModel";

/** Bound retained formatted strings and serialized size before posting any page. */
export function spreadsheetWindow(
  workbook: WorkBook,
  name: string,
  contentLimited = false,
): SpreadsheetWindow {
  const sheet = workbook.Sheets[name];
  if (!sheet) throw new Error("This worksheet is unavailable.");
  const ref = sheet["!ref"];
  if (!ref) return { name, columns: [], rows: [], truncated: contentLimited, contentLimited };
  const range = utils.decode_range(ref);
  const fullRange = utils.decode_range(sheet["!fullref"] ?? ref);
  const endRow = Math.min(range.e.r, range.s.r + SPREADSHEET_PREVIEW_ROWS - 1);
  const endColumn = Math.min(range.e.c, range.s.c + SPREADSHEET_PREVIEW_COLUMNS - 1);
  const columns = Array.from({ length: endColumn - range.s.c + 1 }, (_, i) =>
    utils.encode_col(range.s.c + i),
  );
  const rows: SpreadsheetWindow["rows"] = [];
  const encoder = new TextEncoder();
  let characters = 0;
  // Reserve response metadata, worksheet names, labels, and JSON punctuation.
  let payloadBytes = 128 * 1024;
  let truncated = contentLimited || fullRange.e.r > endRow || fullRange.e.c > endColumn;
  outer: for (let row = range.s.r; row <= endRow; row++) {
    const cells: string[] = [];
    payloadBytes += 64 + columns.length;
    for (let column = range.s.c; column <= endColumn; column++) {
      const cell = sheet[utils.encode_cell({ r: row, c: column })];
      const text = cell
        ? (cell.v === undefined || cell.t === "z") && cell.f
          ? `=${cell.f}`
          : utils.format_cell(cell)
        : "";
      const clipped = text.slice(0, SPREADSHEET_PREVIEW_CELL_CHARACTERS);
      if (text.length > clipped.length) truncated = true;
      const cost = encoder.encode(JSON.stringify(clipped)).length + 1;
      if (
        characters + clipped.length > SPREADSHEET_PREVIEW_TEXT_CHARACTERS ||
        payloadBytes + cost > SPREADSHEET_PREVIEW_PAYLOAD_BYTES
      ) {
        contentLimited = truncated = true;
        if (cells.length)
          rows.push({
            number: row + 1,
            cells: cells.concat(Array<string>(columns.length - cells.length).fill("")),
          });
        break outer;
      }
      characters += clipped.length;
      payloadBytes += cost;
      cells.push(clipped);
    }
    rows.push({ number: row + 1, cells });
  }
  return { name, columns, rows, truncated, contentLimited };
}

export function spreadsheetTable(window: SpreadsheetWindow, page = 0): SpreadsheetTable {
  const pageCount = Math.max(1, Math.ceil(window.rows.length / SPREADSHEET_PREVIEW_PAGE_ROWS));
  if (!Number.isInteger(page) || page < 0 || page >= pageCount)
    throw new Error("This worksheet page is unavailable.");
  return {
    ...window,
    rows: window.rows.slice(
      page * SPREADSHEET_PREVIEW_PAGE_ROWS,
      (page + 1) * SPREADSHEET_PREVIEW_PAGE_ROWS,
    ),
    page,
    pageCount,
    totalRows: window.rows.length,
  };
}
