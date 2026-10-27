import { describe, expect, it } from "@effect/vitest";
import { strToU8, zipSync } from "fflate";

import { documentKind, extractDocumentText } from "./documentText.ts";

const office = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)])));

describe("documentText", () => {
  it("knows which files it can read", () => {
    expect(documentKind("Report.PDF")).toBe("pdf");
    expect(documentKind("notes.md")).toBe("text");
    expect(documentKind("old.doc")).toBeUndefined();
  });

  it("reads Word paragraphs, slides in order, and spreadsheet cells", async () => {
    const docx = office({
      "word/document.xml":
        '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world &amp; co</w:t></w:r></w:p><w:p><w:r><w:tab/><w:t>Next</w:t></w:r></w:p></w:body></w:document>',
    });
    expect(await extractDocumentText("docx", docx)).toBe("Hello world & co\nNext");

    const pptx = office({
      "ppt/slides/slide10.xml": "<p:sld><a:p><a:r><a:t>Last</a:t></a:r></a:p></p:sld>",
      "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>",
    });
    expect(await extractDocumentText("pptx", pptx)).toBe("Slide 1\nSecond\n\nSlide 2\nLast");

    const xlsx = office({
      "xl/sharedStrings.xml": "<sst><si><t>Item</t></si><si><t>Apple</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>Price</v></c></row><row><c r="A2" t="s"><v>1</v></c><c r="B2"><v>3</v></c></row></sheetData></worksheet>',
    });
    expect(await extractDocumentText("xlsx", xlsx)).toBe("Sheet 1\nItem,Price\nApple,3");
  });
});
