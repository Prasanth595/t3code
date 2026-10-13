export const SPREADSHEET_PREVIEW_ROWS = 500;
export const SPREADSHEET_PREVIEW_COLUMNS = 50;
export const SPREADSHEET_PREVIEW_CELL_CHARACTERS = 2000;

export type SpreadsheetTable = {
  name: string;
  columns: string[];
  rows: { number: number; cells: string[] }[];
  truncated: boolean;
};
export type SpreadsheetRequest =
  | { type: "load"; bytes: Uint8Array }
  | { type: "sheet"; name: string };
export type SpreadsheetResponse = { sheets: string[]; table: SpreadsheetTable } | { error: string };
