import JSZip from "jszip";
import { utils, write, type WorkBook } from "xlsx";
import { describe, expect, it } from "vite-plus/test";
import { openSpreadsheetDocument } from "./spreadsheetArchive";
import { spreadsheetTable, spreadsheetWindow } from "./spreadsheetDocument";
import {
  SPREADSHEET_PREVIEW_ROWS,
  SPREADSHEET_PREVIEW_COLUMNS,
  SPREADSHEET_PREVIEW_TEXT_CHARACTERS,
  SPREADSHEET_PREVIEW_PAYLOAD_BYTES,
} from "./spreadsheetPreviewModel";

function roundTrip(workbook: WorkBook) {
  return openSpreadsheetDocument(
    new Uint8Array(write(workbook, { type: "array", bookType: "xlsx" })),
  );
}
const table = (workbook: WorkBook, name: string, page = 0) =>
  spreadsheetTable(spreadsheetWindow(workbook, name), page);

describe("read-only Excel preview", () => {
  it("offers a complexity fallback instead of claiming an oversized first cell is empty", async () => {
    const wb = utils.book_new();
    utils.book_append_sheet(wb, utils.aoa_to_sheet([["x".repeat(20000)]]), "Oversized cell");
    const doc = await roundTrip(wb);
    await expect(doc.readSheet("Oversized cell")).rejects.toThrow("too complex");
  });
  it("allows unused large formats belonging to another worksheet", async () => {
    const wb = utils.book_new();
    utils.book_append_sheet(wb, utils.aoa_to_sheet([[1]]), "Normal");
    const styled = utils.aoa_to_sheet([[1]]);
    styled.A1!.z = `"${"x".repeat(1500)}"`;
    utils.book_append_sheet(wb, styled, "Large format");
    const doc = await roundTrip(wb);
    expect(table((await doc.readSheet("Normal")).workbook, "Normal").rows[0]?.cells).toEqual(["1"]);
    await expect(doc.readSheet("Large format")).rejects.toThrow("too complex");
  });
  it("bounds custom formats before they can amplify every numeric cell", async () => {
    const wb = utils.book_new();
    const sheet = utils.aoa_to_sheet([[1]]);
    sheet.A1!.z = `"${"x".repeat(1500)}"`;
    utils.book_append_sheet(wb, sheet, "Format");
    const doc = await roundTrip(wb);
    await expect(doc.readSheet("Format")).rejects.toThrow("too complex");
  });
  it("cancels an obsolete worksheet before inflating its XML", async () => {
    const wb = utils.book_new();
    utils.book_append_sheet(wb, utils.aoa_to_sheet([["Cancelled"]]), "Data");
    const doc = await roundTrip(wb);
    const controller = new AbortController();
    controller.abort();
    await expect(doc.readSheet("Data", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
  it("preserves date formats and the 1904 date system", async () => {
    const wb = utils.book_new();
    const sheet = utils.aoa_to_sheet([[1]]);
    sheet.A1!.z = "yyyy-mm-dd";
    utils.book_append_sheet(wb, sheet, "Dates");
    wb.Workbook = { WBProps: { date1904: true } };
    const doc = await roundTrip(wb);
    expect(table((await doc.readSheet("Dates")).workbook, "Dates").rows[0]?.cells).toEqual([
      "1904-01-02",
    ]);
  });
  it("rejects worksheet XML over the parse budget before constructing cells", async () => {
    const wb = utils.book_new();
    utils.book_append_sheet(wb, utils.aoa_to_sheet([["Small"]]), "Large XML");
    const zip = await JSZip.loadAsync(write(wb, { type: "array", bookType: "xlsx" }));
    zip.file("xl/worksheets/sheet1.xml", " ".repeat(24 * 1024 * 1024 + 1));
    const doc = await openSpreadsheetDocument(
      await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
    );
    await expect(doc.readSheet("Large XML")).rejects.toThrow("too complex");
  });
  it("keeps prefixed worksheet tags and implicit cell coordinates", async () => {
    const wb = utils.book_new();
    utils.book_append_sheet(wb, utils.aoa_to_sheet([["😀 Łódź", "Second"]]), "Prefix");
    const zip = await JSZip.loadAsync(write(wb, { type: "array", bookType: "xlsx" }));
    let xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    xml = xml
      .replace(/xmlns="([^"]*)"/, 'xmlns:x="$1"')
      .replace(
        /<(\/?)(worksheet|dimension|sheetViews|sheetView|sheetFormatPr|sheetData|row|c|v|is|t|ignoredErrors|ignoredError)\b/g,
        "<$1x:$2",
      )
      .replace(/ r="[AB]1"/g, "");
    zip.file("xl/worksheets/sheet1.xml", xml);
    const doc = await openSpreadsheetDocument(await zip.generateAsync({ type: "uint8array" }));
    expect(table((await doc.readSheet("Prefix")).workbook, "Prefix").rows[0]?.cells).toEqual([
      "😀 Łódź",
      "Second",
    ]);
  });
  it("parses only the selected sheet and ignores malformed unselected/hidden worksheets", async () => {
    const wb = utils.book_new();
    utils.book_append_sheet(wb, utils.aoa_to_sheet([["Selected"]]), "First");
    utils.book_append_sheet(wb, utils.aoa_to_sheet([["Unused"]]), "Other");
    utils.book_append_sheet(wb, utils.aoa_to_sheet([["Hidden"]]), "Hidden");
    wb.Workbook = {
      Sheets: [
        { name: "First", Hidden: 0 },
        { name: "Other", Hidden: 0 },
        { name: "Hidden", Hidden: 1 },
      ],
    };
    const zip = await JSZip.loadAsync(write(wb, { type: "array", bookType: "xlsx" }));
    zip.file("xl/worksheets/sheet2.xml", "<malformed>");
    zip.file("xl/worksheets/sheet3.xml", "<malformed>");
    const doc = await openSpreadsheetDocument(await zip.generateAsync({ type: "uint8array" }));
    expect(doc.sheets).toEqual(["First", "Other"]);
    const result = await doc.readSheet("First");
    expect(Object.keys(result.workbook.Sheets)).toEqual(["First"]);
    expect(table(result.workbook, "First").rows[0]?.cells).toEqual(["Selected"]);
    await expect(doc.readSheet("Other")).rejects.toThrow();
    await expect(doc.readSheet("Hidden")).rejects.toThrow("unavailable");
  });
  it("bounds parsed cells before SheetJS and paginates the selected window", async () => {
    const wb = utils.book_new();
    utils.book_append_sheet(
      wb,
      utils.aoa_to_sheet(
        Array.from({ length: 650 }, (_, r) =>
          Array.from({ length: 60 }, (_, c) => `${r + 1}:${c + 1}`),
        ),
      ),
      "Data",
    );
    const doc = await roundTrip(wb);
    const result = await doc.readSheet("Data");
    expect(
      Object.keys(result.workbook.Sheets.Data!).filter((key) => !key.startsWith("!")),
    ).toHaveLength(500 * 50);
    const window = spreadsheetWindow(result.workbook, "Data");
    expect(spreadsheetTable(window).rows).toHaveLength(100);
    expect(spreadsheetTable(window, 1).rows[0]?.number).toBe(101);
    expect(spreadsheetTable(window, 4).rows.at(-1)?.number).toBe(500);
    expect(spreadsheetTable(window).truncated).toBe(true);
    expect(() => spreadsheetTable(window, 5)).toThrow("unavailable");
  });
  it("caps aggregate long shared-string content and serialized output", async () => {
    const wb = utils.book_new();
    utils.book_append_sheet(
      wb,
      utils.aoa_to_sheet(Array.from({ length: 500 }, () => Array(50).fill("x".repeat(2000)))),
      "Long",
    );
    const doc = await openSpreadsheetDocument(
      new Uint8Array(
        write(wb, { type: "array", bookType: "xlsx", bookSST: true, compression: true }),
      ),
    );
    const { workbook } = await doc.readSheet("Long");
    const window = spreadsheetWindow(workbook, "Long");
    expect(
      window.rows.reduce((n, r) => n + r.cells.reduce((s, c) => s + c.length, 0), 0),
    ).toBeLessThanOrEqual(SPREADSHEET_PREVIEW_TEXT_CHARACTERS);
    expect(window.contentLimited).toBe(true);
    expect(window.truncated).toBe(true);
    const response = { id: 1, sheets: doc.sheets, table: spreadsheetTable(window) };
    expect(new TextEncoder().encode(JSON.stringify(response)).length).toBeLessThan(
      SPREADSHEET_PREVIEW_PAYLOAD_BYTES,
    );
  });
  it("applies the serialization budget to escaping-heavy text", () => {
    const wb = utils.book_new();
    utils.book_append_sheet(
      wb,
      utils.aoa_to_sheet(Array.from({ length: 500 }, () => Array(50).fill("\u0001".repeat(2000)))),
      "Escape",
    );
    const window = spreadsheetWindow(wb, "Escape");
    expect(window.contentLimited).toBe(true);
    expect(
      new TextEncoder().encode(
        JSON.stringify({ id: 1, sheets: ["Escape"], table: spreadsheetTable(window) }),
      ).length,
    ).toBeLessThan(SPREADSHEET_PREVIEW_PAYLOAD_BYTES);
  });
  it("prunes and remaps shared strings while preserving rich text and C9000 despite an A1 dimension", async () => {
    const wb = utils.book_new();
    utils.book_append_sheet(
      wb,
      { C9000: { t: "s", v: "Needed" }, "!ref": "C9000:C9000" },
      "Sparse",
    );
    const zip = await JSZip.loadAsync(
      write(wb, { type: "array", bookType: "xlsx", bookSST: true }),
    );
    zip.file(
      "xl/sharedStrings.xml",
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>Unused</t></si><si><r><t>Łódź </t></r><r><t>&amp; legal</t></r></si></sst>',
    );
    const xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    zip.file(
      "xl/worksheets/sheet1.xml",
      xml
        .replace('<dimension ref="C9000"', '<dimension ref="A1:C9000"')
        .replace("<v>0</v>", "<v>1</v>"),
    );
    const doc = await openSpreadsheetDocument(await zip.generateAsync({ type: "uint8array" }));
    const result = await doc.readSheet("Sparse");
    expect(table(result.workbook, "Sparse").rows).toEqual([
      { number: 9000, cells: ["Łódź & legal"] },
    ]);
  });
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
    const decoded = await openSpreadsheetDocument(await zip.generateAsync({ type: "uint8array" }));
    expect(table((await decoded.readSheet("Formula")).workbook, "Formula").rows[0]?.cells).toEqual([
      "=SUM(1,2,3)",
    ]);
  });
  it("reads multiple sheets, saved formula results, number formats, Unicode and literal markup", async () => {
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
    const decoded = await roundTrip(workbook);
    expect(decoded.sheets).toEqual(["Prospects", "Notes"]);
    const preview = table((await decoded.readSheet("Prospects")).workbook, "Prospects");
    expect(preview.columns).toEqual(["A", "B", "C", "D"]);
    expect(preview.rows[1]?.cells).toEqual([
      "Łódź <script>alert(1)</script>",
      "£1,234.50",
      "6",
      "=SUM(1,2)",
    ]);
    expect(table((await decoded.readSheet("Notes")).workbook, "Notes").rows[0]?.cells).toEqual([
      "Another sheet",
    ]);
  });
  it("preserves sparse cell coordinates and empty worksheets", async () => {
    const workbook = utils.book_new();
    utils.book_append_sheet(
      workbook,
      { C7: { t: "s", v: "Offset" }, E7: { t: "s", v: "Last" }, "!ref": "C7:E7" },
      "Sparse",
    );
    utils.book_append_sheet(workbook, {}, "Empty");
    const decoded = await roundTrip(workbook);
    expect(table((await decoded.readSheet("Sparse")).workbook, "Sparse")).toMatchObject({
      columns: ["C", "D", "E"],
      rows: [{ number: 7, cells: ["Offset", "", "Last"] }],
    });
    expect(table((await decoded.readSheet("Empty")).workbook, "Empty").rows).toEqual([]);
  });
  it("finds content below row 500 and bounds oversized cell text", async () => {
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
    const doc = await roundTrip(workbook);
    const preview = table((await doc.readSheet("Offset")).workbook, "Offset");
    expect(preview.rows[0]?.number).toBe(9000);
    expect(preview.rows[0]?.cells[0]).toBe("Far row");
    expect(preview.rows[0]?.cells[1]).toHaveLength(2000);
    expect(preview.truncated).toBe(true);
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
    const window = spreadsheetWindow(workbook, "Large");
    expect(window.truncated).toBe(true);
    expect(window.rows).toHaveLength(SPREADSHEET_PREVIEW_ROWS);
    expect(window.columns).toHaveLength(SPREADSHEET_PREVIEW_COLUMNS);
    expect(spreadsheetTable(window).rows).toHaveLength(100);
    expect(spreadsheetTable(window).pageCount).toBe(5);
  });
});
