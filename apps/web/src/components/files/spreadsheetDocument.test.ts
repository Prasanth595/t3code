import JSZip from "jszip";
import { utils, write, type WorkBook } from "xlsx";
import { describe, expect, it } from "vite-plus/test";
import {
  readSpreadsheetDocument,
  spreadsheetTable,
  visibleSpreadsheetSheets,
} from "./spreadsheetDocument";
import { SPREADSHEET_PREVIEW_ROWS, SPREADSHEET_PREVIEW_COLUMNS } from "./spreadsheetPreviewModel";

function roundTrip(workbook: WorkBook) {
  return readSpreadsheetDocument(
    new Uint8Array(write(workbook, { type: "array", bookType: "xlsx" })),
  );
}

describe("read-only Excel preview", () => {
  it("shows formulas whose OOXML value element is empty rather than dropping the cell", async () => {
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, utils.aoa_to_sheet([[123]]), "Formula");
    const zip = await JSZip.loadAsync(write(workbook, { type: "array", bookType: "xlsx" }));
    const sheet = zip.file("xl/worksheets/sheet1.xml");
    if (!sheet) throw new Error("Missing test worksheet");
    zip.file(
      "xl/worksheets/sheet1.xml",
      (await sheet.async("string")).replace(
        /<c\b[^>]*r="A1"[^>]*>.*?<\/c>/,
        '<c r="A1"><f>SUM(1,2,3)</f><v></v></c>',
      ),
    );
    const decoded = readSpreadsheetDocument(await zip.generateAsync({ type: "uint8array" }));
    expect(spreadsheetTable(decoded, "Formula").rows[0]?.cells).toEqual(["=SUM(1,2,3)"]);
  });
  it("reads multiple sheets, saved formula results, number formats, Unicode and literal markup", () => {
    const workbook = utils.book_new();
    const sheet = utils.aoa_to_sheet([
      ["Firm", "Revenue", "Total", "Missing result"],
      ["Łódź <script>alert(1)</script>", 1234.5, 6, null],
    ]);
    sheet.B2!.z = '"£"#,##0.00';
    sheet.C2!.f = "SUM(1,2,3)";
    sheet.D2 = { t: "n", f: "SUM(1,2)" };
    utils.book_append_sheet(workbook, sheet, "Prospects");
    utils.book_append_sheet(workbook, utils.aoa_to_sheet([["Another sheet"]]), "Notes");
    const decoded = roundTrip(workbook);
    expect(visibleSpreadsheetSheets(decoded)).toEqual(["Prospects", "Notes"]);
    const table = spreadsheetTable(decoded, "Prospects");
    expect(table.columns).toEqual(["A", "B", "C", "D"]);
    expect(table.rows[1]?.cells).toEqual([
      "Łódź <script>alert(1)</script>",
      "£1,234.50",
      "6",
      "=SUM(1,2)",
    ]);
    expect(spreadsheetTable(decoded, "Notes").rows[0]?.cells).toEqual(["Another sheet"]);
  });
  it("preserves sparse cell coordinates and empty worksheets", () => {
    const workbook = utils.book_new();
    utils.book_append_sheet(
      workbook,
      { C7: { t: "s", v: "Offset" }, E7: { t: "s", v: "Last" }, "!ref": "C7:E7" },
      "Sparse",
    );
    utils.book_append_sheet(workbook, {}, "Empty");
    const decoded = roundTrip(workbook);
    expect(spreadsheetTable(decoded, "Sparse")).toMatchObject({
      columns: ["C", "D", "E"],
      rows: [{ number: 7, cells: ["Offset", "", "Last"] }],
    });
    expect(spreadsheetTable(decoded, "Empty").rows).toEqual([]);
  });
  it("finds content below row 500 and bounds oversized cell text", () => {
    const workbook = utils.book_new();
    utils.book_append_sheet(
      workbook,
      {
        C9000: { t: "s", v: "Far row" },
        D9000: { t: "s", v: "x".repeat(5000) },
        "!ref": "C9000:D9000",
      },
      "Offset",
    );
    const table = spreadsheetTable(roundTrip(workbook), "Offset");
    expect(table.rows[0]?.number).toBe(9000);
    expect(table.rows[0]?.cells[0]).toBe("Far row");
    expect(table.rows[0]?.cells[1]).toHaveLength(2000);
    expect(table.truncated).toBe(true);
  });
  it("bounds large sheets and exposes only visible worksheets", () => {
    const workbook = utils.book_new();
    const sheet = utils.aoa_to_sheet([["Start"]]);
    sheet["!ref"] = "A1:XFD1048576";
    utils.book_append_sheet(workbook, sheet, "Large");
    utils.book_append_sheet(workbook, {}, "Hidden");
    workbook.Workbook = {
      Sheets: [
        { name: "Large", Hidden: 0 },
        { name: "Hidden", Hidden: 1 },
      ],
    };
    const table = spreadsheetTable(workbook, "Large");
    expect(table.truncated).toBe(true);
    expect(table.rows).toHaveLength(SPREADSHEET_PREVIEW_ROWS);
    expect(table.columns).toHaveLength(SPREADSHEET_PREVIEW_COLUMNS);
    expect(visibleSpreadsheetSheets(workbook)).toEqual(["Large"]);
  });
});
