import JSZip from "jszip";
import { zipSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";
import { validateOfficeArchive } from "./officeArchive";
import { validateOfficeArchiveContents } from "./officeArchiveContents";

const archive = async (part: string, compressed = false) => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types />");
  zip.file(part, "<document />");
  return zip.generateAsync({ type: "uint8array", compression: compressed ? "DEFLATE" : "STORE" });
};

function directoryOffsets(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  let pos = view.getUint32(end + 16, true);
  const result: number[] = [];
  while (pos < end) {
    result.push(pos);
    pos +=
      46 +
      view.getUint16(pos + 28, true) +
      view.getUint16(pos + 30, true) +
      view.getUint16(pos + 32, true);
  }
  return result;
}

function unicodePath(raw: string, effective: string) {
  const encoder = new TextEncoder();
  let crc = -1;
  for (const byte of encoder.encode(raw)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const result = new Uint8Array(5 + encoder.encode(effective).length);
  result[0] = 1;
  new DataView(result.buffer).setUint32(1, (crc ^ -1) >>> 0, true);
  result.set(encoder.encode(effective), 5);
  return result;
}

function aliasedArchive(effective: string, contents = "<document />", duplicate = false) {
  const encoder = new TextEncoder();
  return zipSync({
    "[Content_Types].xml": encoder.encode("<Types />"),
    ...(duplicate ? { "word/document.xml": encoder.encode("<document />") } : {}),
    "payload.xml": [
      encoder.encode(contents),
      { extra: { 0x7075: unicodePath("payload.xml", effective) } },
    ],
  });
}

describe("Office archive validation", () => {
  it.each(["custom.data", "payload.rels"])(
    "budgets Word content selected through relationships at %s",
    async (target) => {
      const zip = new JSZip();
      zip.file("[Content_Types].xml", "<Types />");
      zip.file("word/document.xml", "<document />");
      zip.file(target, `<document>${"<p><r><t>Text</t></r></p>".repeat(5000)}</document>`);
      zip.file(
        "_rels/.rels",
        `<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`,
      );
      const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
      expect(() => validateOfficeArchiveContents(bytes, "docx")).toThrow("too complex");
    },
  );
  it("budgets images reached through relative Word relationships outside word/media", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("word/document.xml", "<document />");
    zip.file(
      "word/_rels/document.xml.rels",
      '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../picture.bin"/></Relationships>',
    );
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47], 0);
    png.set([0x49, 0x48, 0x44, 0x52], 12);
    const view = new DataView(png.buffer);
    view.setUint32(16, 100000);
    view.setUint32(20, 100000);
    zip.file("picture.bin", png);
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(() => validateOfficeArchiveContents(bytes, "docx")).toThrow("too complex");
  });
  it("budgets the effective Unicode part name used by the renderer", async () => {
    const bytes = aliasedArchive(
      "word/document.xml",
      `<document>${"<p><r><t>Text</t></r></p>".repeat(5000)}</document>`,
    );
    expect(validateOfficeArchive(bytes, "docx").at(-1)?.name).toBe("word/document.xml");
    expect((await JSZip.loadAsync(bytes)).file("word/document.xml")).not.toBeNull();
    expect(() => validateOfficeArchiveContents(bytes, "docx")).toThrow("too complex");
    expect(() =>
      validateOfficeArchiveContents(
        aliasedArchive("word/document.xml", "x".repeat(2 * 1024 * 1024 + 1)),
        "docx",
      ),
    ).toThrow("too complex");
  });
  it("rejects effective-name collisions before a parser can replace a budgeted part", () => {
    expect(() =>
      validateOfficeArchive(aliasedArchive("word/document.xml", "<document />", true), "docx"),
    ).toThrow("cannot be previewed");
  });
  it.each([
    "word//document.xml",
    "word/../word/document.xml",
    "/word/document.xml",
    "word\\document.xml",
    "word/\0document.xml",
  ])("rejects unsafe effective names: %s", (name) => {
    expect(() => validateOfficeArchive(aliasedArchive(name), "docx")).toThrow(
      "cannot be previewed",
    );
  });
  it("preserves Unicode legacy names and central-only Unicode metadata", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("word/document.xml", "<document />");
    zip.file("word/café.xml", "<custom />");
    const bytes = await zip.generateAsync({
      type: "uint8array",
      encodeFileName: (name) => name.replaceAll("é", "\x82"),
    });
    expect(
      validateOfficeArchive(bytes, "docx").some((entry) => entry.name === "word/café.xml"),
    ).toBe(true);
    expect((await JSZip.loadAsync(bytes)).file("word/café.xml")).not.toBeNull();
    const alias = aliasedArchive("word/document.xml");
    const view = new DataView(alias.buffer);
    const central = directoryOffsets(alias).at(-1)!;
    const local = view.getUint32(central + 42, true);
    view.setUint16(local + 30 + view.getUint16(local + 26, true), 0x9999, true);
    expect(() => validateOfficeArchiveContents(alias, "docx")).not.toThrow();
    expect((await JSZip.loadAsync(alias)).file("word/document.xml")).not.toBeNull();
  });
  it.each(["crc", "version", "utf8"])(
    "matches JSZip when Unicode metadata is ignored: %s",
    async (mode) => {
      const bytes = aliasedArchive("word/document.xml", "<custom />", true);
      const view = new DataView(bytes.buffer);
      const central = directoryOffsets(bytes).at(-1)!;
      const local = view.getUint32(central + 42, true);
      const extra = central + 46 + view.getUint16(central + 28, true);
      if (mode === "crc") bytes[extra + 5]! ^= 1;
      if (mode === "version") bytes[extra + 4] = 2;
      if (mode === "utf8") {
        view.setUint16(central + 8, 0x800, true);
        view.setUint16(local + 6, 0x800, true);
      }
      expect(validateOfficeArchive(bytes, "docx").at(-1)?.name).toBe("payload.xml");
      expect((await JSZip.loadAsync(bytes)).file("payload.xml")).not.toBeNull();
    },
  );
  it.each([
    [0xc0, 0xaf],
    [0xe0, 0x80],
    [0xff, 0xff],
  ])(
    "rejects malformed name bytes even when a browser decoder would accept them: %j",
    async (...malformed) => {
      const zip = await JSZip.loadAsync(await archive("word/document.xml"));
      zip.file("wordXXdocument.xml", "<document />");
      const bytes = await zip.generateAsync({ type: "uint8array" });
      const view = new DataView(bytes.buffer);
      const central = directoryOffsets(bytes).at(-1)!;
      const local = view.getUint32(central + 42, true);
      bytes.set(malformed, central + 46 + 4);
      bytes.set(malformed, local + 30 + 4);
      expect(() => validateOfficeArchive(bytes, "docx")).toThrow("cannot be previewed");
    },
  );
  it("does not strip a filename BOM that JSZip preserves", () => {
    expect(() => validateOfficeArchive(aliasedArchive("\ufeffword/document.xml"), "docx")).toThrow(
      "cannot be previewed",
    );
  });
  it.each([
    ["docx", "word/document.xml"],
    ["xlsx", "xl/workbook.xml"],
  ] as const)("accepts a complete %s package", async (kind, part) => {
    const bytes = await archive(part);
    expect(() => validateOfficeArchive(bytes, kind)).not.toThrow();
  });
  it("rejects non-Office archives, encrypted containers, and truncated ZIPs", async () => {
    const bytes = await archive("word/document.xml");
    expect(() => validateOfficeArchive(bytes, "xlsx")).toThrow("cannot be previewed");
    expect(() => validateOfficeArchive(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), "docx")).toThrow(
      "cannot be previewed",
    );
    expect(() => validateOfficeArchive(bytes.subarray(0, bytes.length - 1), "docx")).toThrow(
      "cannot be previewed",
    );
  });
  it("rejects excessive declared expansion before decompressing content", async () => {
    const bytes = await archive("word/document.xml");
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < bytes.length - 46; index++) {
      if (view.getUint32(index, true) === 0x02014b50) {
        view.setUint32(index + 24, 65 * 1024 * 1024, true);
        break;
      }
    }
    expect(() => validateOfficeArchive(bytes, "docx")).toThrow("too large");
  });
  it("rejects a second end-marker hidden in a ZIP comment", async () => {
    const original = await archive("xl/workbook.xml");
    const zip = new Uint8Array(original.length + 22);
    zip.set(original);
    const view = new DataView(zip.buffer);
    view.setUint16(original.length - 2, 22, true);
    // A parser scanning for the last signature would treat the comment as another directory.
    view.setUint32(original.length, 0x06054b50, true);
    expect(() => validateOfficeArchive(zip, "xlsx")).toThrow("cannot be previewed");
    view.setUint32(original.length, 0, true);
    expect(() => validateOfficeArchive(zip, "xlsx")).not.toThrow();
    view.setUint32(zip.length - 4, 0x06054b50, true);
    expect(() => validateOfficeArchive(zip, "xlsx")).toThrow("cannot be previewed");
  });
  it("rejects a local size that would allocate past the central-directory budget", async () => {
    const bytes = await archive("xl/workbook.xml", true);
    const view = new DataView(bytes.buffer);
    const entry = directoryOffsets(bytes)[0]!;
    const local = view.getUint32(entry + 42, true);
    view.setUint32(local + 22, 65 * 1024 * 1024, true);
    expect(() => validateOfficeArchive(bytes, "xlsx")).toThrow("cannot be previewed");
  });
  it("checks actual DEFLATE output when both headers lie consistently", async () => {
    const bytes = await archive("xl/workbook.xml", true);
    const view = new DataView(bytes.buffer);
    const entry = directoryOffsets(bytes)[0]!;
    const local = view.getUint32(entry + 42, true);
    view.setUint32(entry + 24, 1, true);
    view.setUint32(local + 22, 1, true);
    expect(() => validateOfficeArchive(bytes, "xlsx")).not.toThrow();
    expect(() => validateOfficeArchiveContents(bytes, "xlsx")).toThrow("cannot be previewed");
  });
  it("checks a local filename and compression method before inflation", async () => {
    const bytes = await archive("xl/workbook.xml", true);
    const view = new DataView(bytes.buffer);
    const local = view.getUint32(directoryOffsets(bytes)[0]! + 42, true);
    const renamed = bytes.slice();
    renamed[local + 30] = 120;
    expect(() => validateOfficeArchive(renamed, "xlsx")).toThrow("cannot be previewed");
    view.setUint16(local + 8, 99, true);
    expect(() => validateOfficeArchive(bytes, "xlsx")).toThrow("cannot be previewed");
  });
  it("accepts streamed data descriptors and rejects a forged descriptor", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("xl/workbook.xml", "<workbook />");
    const bytes = await zip.generateAsync({
      type: "uint8array",
      streamFiles: true,
      compression: "DEFLATE",
    });
    expect(() => validateOfficeArchiveContents(bytes, "xlsx")).not.toThrow();
    const entry = validateOfficeArchive(bytes, "xlsx")[0]!;
    bytes[entry.end + 4] = bytes[entry.end + 4]! ^ 1;
    expect(() => validateOfficeArchive(bytes, "xlsx")).toThrow("cannot be previewed");
  });
  it("rejects overlapping or duplicate local entries", async () => {
    const bytes = await archive("xl/workbook.xml");
    const view = new DataView(bytes.buffer);
    const offsets = directoryOffsets(bytes);
    view.setUint32(offsets[1]! + 42, view.getUint32(offsets[0]! + 42, true), true);
    expect(() => validateOfficeArchive(bytes, "xlsx")).toThrow("cannot be previewed");
  });
  it("caps Word nodes and decoded image pixels before constructing a DOM", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file(
      "word/document.xml",
      `<document>${"<p><r><t>Text</t></r></p>".repeat(5000)}</document>`,
    );
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(() => validateOfficeArchiveContents(bytes, "docx")).toThrow("too complex");
    zip.file("word/document.xml", "<document />");
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47], 0);
    png.set([0x49, 0x48, 0x44, 0x52], 12);
    const view = new DataView(png.buffer);
    view.setUint32(16, 100000);
    view.setUint32(20, 100000);
    zip.file("word/media/image.png", png);
    const imageBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(() => validateOfficeArchiveContents(imageBytes, "docx")).toThrow("too complex");
  });
  it("does not count unused Word style catalogs as rendered document nodes", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("word/document.xml", "<document><p>One page</p></document>");
    zip.file("word/styles.xml", `<styles>${"<style><rPr /></style>".repeat(9000)}</styles>`);
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(() => validateOfficeArchiveContents(bytes, "docx")).not.toThrow();
  });
});
