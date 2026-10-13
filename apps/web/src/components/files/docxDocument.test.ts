// @vitest-environment jsdom
import JSZip from "jszip";
import { describe, expect, it, vi } from "vite-plus/test";
import { renderDocxDocument } from "./docxDocument";

describe("Word document rendering", () => {
  it("does not parse or create document nodes after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const create = vi.spyOn(document, "createElement");
    await expect(renderDocxDocument(new Uint8Array(), controller.signal)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    create.mockRestore();
  });
  it("cancels a queued render before its first DOM phase", async () => {
    const controller = new AbortController();
    const create = vi.spyOn(document, "createElement");
    const rendering = renderDocxDocument(new Uint8Array(), controller.signal);
    controller.abort();
    await expect(rendering).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    create.mockRestore();
  });
  it("renders actual OOXML text and tables with document styles in a standalone inert page", async () => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.file(
      "_rels/.rels",
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
    zip.file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Łódź Word preview</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>',
    );
    const html = await renderDocxDocument(await zip.generateAsync({ type: "uint8array" }));
    const preview = new DOMParser().parseFromString(html, "text/html");
    expect(preview.body.textContent).toContain("Łódź Word preview");
    expect(preview.querySelector("td")?.textContent).toContain("Table cell");
    expect(preview.querySelector("section.docx")).not.toBeNull();
    expect(preview.head.querySelectorAll("style").length).toBeGreaterThan(1);
    expect(
      preview.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
    ).toContain("default-src 'none'");
    expect(preview.querySelector("script,iframe,object,embed")).toBeNull();
  });
});
