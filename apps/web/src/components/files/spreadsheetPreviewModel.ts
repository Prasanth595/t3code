export const SPREADSHEET_PREVIEW_ROWS = 500;
export const SPREADSHEET_PREVIEW_COLUMNS = 50;
export const SPREADSHEET_PREVIEW_CELL_CHARACTERS = 2000;
export const SPREADSHEET_PREVIEW_PAGE_ROWS = 100;
export const SPREADSHEET_PREVIEW_TEXT_CHARACTERS = 512 * 1024;
export const SPREADSHEET_PREVIEW_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const SPREADSHEET_PREVIEW_TIMEOUT_MS = 15_000;

export type SpreadsheetTable = {
  name: string;
  columns: string[];
  rows: { number: number; cells: string[] }[];
  truncated: boolean;
  contentLimited: boolean;
  page: number;
  pageCount: number;
  totalRows: number;
};
export type SpreadsheetWindow = Omit<SpreadsheetTable, "page" | "pageCount" | "totalRows">;
export type SpreadsheetRequest =
  | { type: "load"; id: number; bytes: Uint8Array }
  | { type: "sheet"; id: number; name: string }
  | { type: "page"; id: number; name: string; page: number };
export type SpreadsheetResponse = { id: number } & (
  | { sheets: string[]; table: SpreadsheetTable }
  | { error: string }
);
