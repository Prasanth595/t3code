import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";
import { validateOfficeArchive } from "./officeArchive";

const archive = async (part: string) => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types />");
  zip.file(part, "<document />");
  return zip.generateAsync({ type: "uint8array" });
};

describe("Office archive validation", () => {
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
});
