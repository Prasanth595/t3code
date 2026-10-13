import { read, utils, type WorkBook } from "xlsx";

import {
  SPREADSHEET_PREVIEW_ROWS,
  SPREADSHEET_PREVIEW_COLUMNS,
  SPREADSHEET_PREVIEW_CELL_CHARACTERS,
  type SpreadsheetTable,
} from "./spreadsheetPreviewModel";

export function readSpreadsheetDocument(bytes: Uint8Array) {
  return read(bytes, { type: "array", cellHTML: false, cellFormula: true, sheetStubs: true });
}

export function visibleSpreadsheetSheets(workbook: WorkBook) {
  return workbook.SheetNames.filter((name, index) => !workbook.Workbook?.Sheets?.[index]?.Hidden);
}

/** Preserve cell coordinates and formatted values; formulas without a saved value show their expression. */
export function spreadsheetTable(workbook: WorkBook, name: string): SpreadsheetTable {
  const sheet = workbook.Sheets[name];
  if (!sheet) throw new Error("This worksheet is unavailable.");
  const ref = sheet["!ref"];
  if (!ref) return { name, columns: [], rows: [], truncated: false };
  const range = utils.decode_range(ref);
  const fullRange = utils.decode_range(sheet["!fullref"] ?? ref);
  let truncated = false;
  const endRow = Math.min(range.e.r, range.s.r + SPREADSHEET_PREVIEW_ROWS - 1);
  const endColumn = Math.min(range.e.c, range.s.c + SPREADSHEET_PREVIEW_COLUMNS - 1);
  const columns = Array.from({ length: endColumn - range.s.c + 1 }, (_, index) =>
    utils.encode_col(range.s.c + index),
  );
  const rows = Array.from({ length: endRow - range.s.r + 1 }, (_, index) => {
    const row = range.s.r + index;
    return {
      number: row + 1,
      cells: columns.map((_, column) => {
        const cell = sheet[utils.encode_cell({ r: row, c: range.s.c + column })];
        if (!cell) return "";
        const text =
          (cell.v === undefined || cell.t === "z") && cell.f
            ? `=${cell.f}`
            : utils.format_cell(cell);
        if (text.length > SPREADSHEET_PREVIEW_CELL_CHARACTERS) truncated = true;
        return text.slice(0, SPREADSHEET_PREVIEW_CELL_CHARACTERS);
      }),
    };
  });
  return {
    name,
    columns,
    rows,
    truncated: truncated || fullRange.e.r > endRow || fullRange.e.c > endColumn,
  };
}
