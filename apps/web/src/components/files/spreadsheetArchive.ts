import JSZip from "jszip";
import { zipSync } from "fflate";
import { SaxesParser, type SaxesTagNS } from "saxes";
import { read, utils } from "xlsx";
import { validateOfficeArchive } from "./officeArchive";
import { SPREADSHEET_PREVIEW_COLUMNS, SPREADSHEET_PREVIEW_ROWS } from "./spreadsheetPreviewModel";

const XML_BYTES = 24 * 1024 * 1024;
const PART_BYTES = 2 * 1024 * 1024;
const SLICE_CHARACTERS = 2 * 1024 * 1024;
const complex = () => {
  throw new Error("This worksheet is too complex to preview. Save it to open it in another app.");
};
const invalid = () => {
  throw new Error(
    "This workbook contains an unsupported worksheet. Save it to open it in another app.",
  );
};
function parser() {
  const sax = new SaxesParser({ xmlns: true });
  sax.on("doctype", invalid);
  return sax;
}
function escapeXml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!,
  );
}
function opening(tag: SaxesTagNS) {
  return `<${tag.name}${Object.values(tag.attributes)
    .map((a) => ` ${a.name}="${escapeXml(a.value)}"`)
    .join("")}>`;
}
function scan(xml: string, onOpen: (tag: SaxesTagNS) => void) {
  const sax = parser();
  sax.on("opentag", onOpen);
  sax.write(xml).close();
}

/** Walk cells without materializing their values, including sheets whose first cell is C9000. */
function cells(
  xml: string,
  visit: (
    cell: { r: number; c: number },
    tag: SaxesTagNS,
    sax: SaxesParser<{ xmlns: true }>,
  ) => void,
) {
  const sax = parser();
  let row = -1;
  let column = -1;
  let inData = false;
  let root = "";
  let rootName = "worksheet";
  let data = "";
  let dataName = "sheetData";
  let rowContentStart = -1;
  let rowOpen = "";
  let actualRow: number | undefined;
  let firstRow = Infinity;
  const spans = new Map<number, { open: string; start: number; end: number }>();
  sax.on("opentag", (tag) => {
    if (!root) {
      root = opening(tag);
      rootName = tag.name;
    }
    if (tag.local === "sheetData") {
      inData = true;
      data = opening(tag);
      dataName = tag.name;
    }
    if (!inData) return;
    if (tag.local === "row") {
      row = tag.attributes.r ? Number(tag.attributes.r.value) - 1 : row + 1;
      column = -1;
      actualRow = undefined;
      rowContentStart = sax.position;
      rowOpen = opening(tag).replace(/\sr="[^"]*"/, "");
    }
    if (tag.local !== "c") return;
    const reference = tag.attributes.r?.value;
    if (reference && !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(reference)) return invalid();
    const coord = reference ? utils.decode_cell(reference) : { r: row, c: column + 1 };
    if (
      !Number.isInteger(coord.r) ||
      !Number.isInteger(coord.c) ||
      coord.r < 0 ||
      coord.r >= 1048576 ||
      coord.c < 0 ||
      coord.c >= 16384
    )
      return invalid();
    if (actualRow !== undefined && actualRow !== coord.r) return invalid();
    actualRow = coord.r;
    row = coord.r;
    if (coord.r < firstRow) {
      firstRow = coord.r;
      for (const retained of spans.keys())
        if (retained >= firstRow + SPREADSHEET_PREVIEW_ROWS) spans.delete(retained);
    }
    column = coord.c;
    visit(coord, tag, sax);
  });
  sax.on("closetag", (tag) => {
    if (
      tag.local === "row" &&
      actualRow !== undefined &&
      actualRow < firstRow + SPREADSHEET_PREVIEW_ROWS
    )
      spans.set(actualRow, {
        open: `${rowOpen.slice(0, -1)} r="${actualRow + 1}">`,
        start: rowContentStart,
        end: sax.position,
      });
    if (tag.local === "sheetData") inData = false;
  });
  sax.write(xml).close();
  // The second pass sees only the bounded row window, rather than scanning every cell twice.
  return `${root}${data || "<sheetData>"}${Array.from(spans.values())
    // Resolve implicit row positions before removing empty or out-of-window rows.
    .map((span) => span.open + xml.slice(span.start, span.end))
    .join("")}</${dataName}></${rootName}>`;
}

function worksheetSlice(xml: string) {
  let range: ReturnType<typeof utils.decode_range> | undefined;
  xml = cells(xml, (coord) => {
    if (!range) range = { s: { ...coord }, e: { ...coord } };
    range.s.r = Math.min(range.s.r, coord.r);
    range.s.c = Math.min(range.s.c, coord.c);
    range.e.r = Math.max(range.e.r, coord.r);
    range.e.c = Math.max(range.e.c, coord.c);
  });
  const fullRange = range;
  const sax = parser();
  let root = "";
  let rootName = "worksheet";
  let dataName = "sheetData";
  let dataOpen = "<sheetData>";
  let rowOpen = "";
  let rowName = "row";
  let rowNumber = -1;
  let column = -1;
  let start = -1;
  let coordinate = "";
  let shared = false;
  let style = 0;
  let inData = false;
  let length = 0;
  let limited = false;
  const rows: string[] = [];
  let rowCells: string[] = [];
  const sharedIds = new Map<number, number>();
  const styleIds = new Set<number>();
  sax.on("opentag", (tag) => {
    if (!root) {
      root = opening(tag);
      rootName = tag.name;
    }
    if (tag.local === "sheetData") {
      inData = true;
      dataName = tag.name;
      dataOpen = opening(tag);
    }
    if (!inData) return;
    if (tag.local === "row") {
      rowNumber = tag.attributes.r ? Number(tag.attributes.r.value) - 1 : rowNumber + 1;
      column = -1;
      rowOpen = opening(tag);
      rowName = tag.name;
      rowCells = [];
    }
    if (tag.local !== "c" || !fullRange) return;
    const ref = tag.attributes.r?.value;
    const coord = ref ? utils.decode_cell(ref) : { r: rowNumber, c: column + 1 };
    column = coord.c;
    if (
      coord.r >= fullRange.s.r + SPREADSHEET_PREVIEW_ROWS ||
      coord.c >= fullRange.s.c + SPREADSHEET_PREVIEW_COLUMNS ||
      limited
    )
      return;
    coordinate = utils.encode_cell(coord);
    start = xml.lastIndexOf("<", sax.position - 1);
    shared = tag.attributes.t?.value === "s";
    style = Number(tag.attributes.s?.value ?? 0);
    if (!Number.isSafeInteger(style) || style < 0) return invalid();
  });
  sax.on("closetag", (tag) => {
    if (tag.local === "c" && start >= 0) {
      let cell = xml.slice(start, sax.position);
      start = -1;
      if (cell.length > 16 * 1024 || length + cell.length > SLICE_CHARACTERS) {
        if (length === 0) return complex();
        limited = true;
        return;
      }
      // Restore implicit coordinates when omitted in the source before passing the slice to SheetJS.
      if (!/\br\s*=/.test(cell.slice(0, cell.indexOf(">"))))
        cell = cell.replace(/^<([^\s>]+)/, `<$1 r="${coordinate}"`);
      if (shared) {
        cell = cell.replace(
          /(<(?:[\w.-]+:)?v\b[^>]*>)([^<]*)(<\/(?:[\w.-]+:)?v>)/,
          (_, open: string, text: string, close: string) => {
            const id = Number(text);
            if (!Number.isSafeInteger(id) || id < 0) return invalid();
            if (!sharedIds.has(id)) sharedIds.set(id, sharedIds.size);
            return `${open}${sharedIds.get(id)}${close}`;
          },
        );
      }
      length += cell.length;
      styleIds.add(style);
      rowCells.push(cell);
    }
    if (tag.local === "row" && rowCells.length)
      rows.push(`${rowOpen}${rowCells.join("")}</${rowName}>`);
    if (tag.local === "sheetData") inData = false;
  });
  sax.write(xml).close();
  return {
    xml: `${root}${dataOpen}${rows.join("")}</${dataName}></${rootName}>`,
    range: fullRange,
    sharedIds,
    styleIds,
    limited,
  };
}

function sharedStringSlice(xml: string, needed: Map<number, number>) {
  const sax = parser();
  let root = "";
  let rootName = "sst";
  let index = -1;
  let start = -1;
  let length = 0;
  const entries = Array<string>(needed.size);
  sax.on("opentag", (tag) => {
    if (!root) {
      root = opening(tag);
      rootName = tag.name;
    }
    if (tag.local === "si") {
      index++;
      if (needed.has(index)) start = xml.lastIndexOf("<", sax.position - 1);
    }
  });
  sax.on("closetag", (tag) => {
    if (tag.local !== "si" || start < 0) return;
    const entry = xml.slice(start, sax.position);
    start = -1;
    if ((length += entry.length) > SLICE_CHARACTERS || entry.length > 16 * 1024) return complex();
    entries[needed.get(index)!] = entry;
  });
  sax.write(xml).close();
  if (entries.filter(Boolean).length !== needed.size) return invalid();
  // Counts describe the filtered dictionary, not the source workbook's full shared-string table.
  root = root.replace(/\s(?:uniqueCount|count)="[^"]*"/g, "");
  return `${root} count="${entries.length}" uniqueCount="${entries.length}">${entries.join("")}</${rootName}>`.replace(
    /> count=/,
    " count=",
  );
}

/** Keep the compressed archive; inflate metadata and the selected worksheet only. */
export async function openSpreadsheetDocument(bytes: Uint8Array) {
  const sizes = new Map(
    validateOfficeArchive(bytes, "xlsx").map((entry) => [entry.name, entry.size]),
  );
  const zip = await JSZip.loadAsync(bytes);
  const part = async (name: string, max: number) => {
    const file = zip.file(name);
    if (!file) return invalid();
    if ((sizes.get(name) ?? Infinity) > max) return complex();
    return file.async("string");
  };
  const workbookXml = await part("xl/workbook.xml", PART_BYTES);
  const relationships = await part("xl/_rels/workbook.xml.rels", PART_BYTES);
  const contentTypes = await part("[Content_Types].xml", PART_BYTES);
  const targets = new Map<string, string>();
  const optionalParts = new Map<string, string>();
  scan(relationships, (tag) => {
    if (tag.local !== "Relationship" || tag.attributes.TargetMode?.value === "External") return;
    const id = tag.attributes.Id?.value;
    const target = tag.attributes.Target?.value;
    const type = tag.attributes.Type?.value;
    if (!id || !target || target.includes("\\") || target.includes(":")) return;
    const pieces = (target.startsWith("/") ? target.slice(1) : `xl/${target}`).split("/");
    const normalized: string[] = [];
    for (const piece of pieces) {
      if (piece === "..") normalized.pop();
      else if (piece && piece !== ".") normalized.push(piece);
    }
    const name = normalized.join("/");
    targets.set(id, name);
    if (type?.endsWith("/styles")) optionalParts.set("styles", name);
    if (type?.endsWith("/sharedStrings")) optionalParts.set("sharedStrings", name);
  });
  const sheets: { name: string; path: string }[] = [];
  scan(workbookXml, (tag) => {
    if (tag.local !== "sheet" || (tag.attributes.state && tag.attributes.state.value !== "visible"))
      return;
    const name = tag.attributes.name?.value;
    const id = Object.values(tag.attributes).find((a) => a.local === "id")?.value;
    const path = id === undefined ? undefined : targets.get(id);
    if (
      !name ||
      name.length > 31 ||
      !path ||
      sheets.length >= 512 ||
      sheets.some((s) => s.name === name)
    )
      return invalid();
    sheets.push({ name, path });
  });
  if (!sheets.length) throw new Error("This workbook has no visible worksheets.");
  return {
    sheets: sheets.map((s) => s.name),
    readSheet: async (name: string, signal?: AbortSignal) => {
      const currentPart = async (path: string, max: number) => {
        signal?.throwIfAborted();
        const xml = await part(path, max);
        signal?.throwIfAborted();
        return xml;
      };
      const sheet = sheets.find((s) => s.name === name);
      if (!sheet) throw new Error("This worksheet is unavailable.");
      const slice = worksheetSlice(await currentPart(sheet.path, XML_BYTES));
      const files: Record<string, Uint8Array> = {};
      const encoder = new TextEncoder();
      files["xl/workbook.xml"] = encoder.encode(workbookXml);
      files["xl/_rels/workbook.xml.rels"] = encoder.encode(relationships);
      files[sheet.path] = encoder.encode(slice.xml);
      const stylePath = optionalParts.get("styles");
      if (stylePath) {
        const styles = await currentPart(stylePath, PART_BYTES);
        let formats = 0;
        let inCellFormats = false;
        let index = 0;
        const codes = new Map<number, string>();
        const usedFormats = new Set<number>();
        const sax = parser();
        sax.on("opentag", (tag) => {
          if (tag.local === "numFmt")
            codes.set(
              Number(tag.attributes.numFmtId?.value),
              tag.attributes.formatCode?.value ?? "",
            );
          if (tag.local === "cellXfs") inCellFormats = true;
          if (tag.local === "xf" && ++formats > 16384) return complex();
          if (tag.local === "xf" && inCellFormats) {
            if (slice.styleIds.has(index))
              usedFormats.add(Number(tag.attributes.numFmtId?.value ?? 0));
            index++;
          }
        });
        sax.on("closetag", (tag) => {
          if (tag.local === "cellXfs") inCellFormats = false;
        });
        sax.write(styles).close();
        // Only formats used by this slice can amplify its values; unused catalogs stay harmless.
        for (const id of usedFormats) if ((codes.get(id)?.length ?? 0) > 1024) return complex();
        files[stylePath] = encoder.encode(styles);
      }
      if (slice.sharedIds.size) {
        const stringPath = optionalParts.get("sharedStrings");
        if (!stringPath) return invalid();
        files[stringPath] = encoder.encode(
          sharedStringSlice(await currentPart(stringPath, XML_BYTES), slice.sharedIds),
        );
      }
      let typesRoot = "";
      let typesName = "Types";
      const types: string[] = [];
      scan(contentTypes, (tag) => {
        if (!typesRoot) {
          typesRoot = opening(tag);
          typesName = tag.name;
          return;
        }
        if (
          tag.local === "Default" ||
          (tag.local === "Override" &&
            files[tag.attributes.PartName?.value.replace(/^\//, "") ?? ""])
        )
          types.push(`${opening(tag).slice(0, -1)}/>`);
      });
      files["[Content_Types].xml"] = encoder.encode(`${typesRoot}${types.join("")}</${typesName}>`);
      // SheetJS sees a small package with one bounded cell slice and its required strings/styles.
      const workbook = read(zipSync(files, { level: 0 }), {
        type: "array",
        sheets: name,
        cellHTML: false,
        cellFormula: true,
        sheetStubs: true,
      });
      if (slice.range && workbook.Sheets[name])
        workbook.Sheets[name]["!fullref"] = utils.encode_range(slice.range);
      return { workbook, limited: slice.limited };
    },
  };
}
