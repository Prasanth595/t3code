// @vitest-environment jsdom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as XLSX from "xlsx";
import JSZip from "jszip";

import { ExcelPreview } from "./ExcelPreview";
import { PowerPointPreview } from "./PowerPointPreview";

function extractAllText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(extractAllText).join("");
  const children = (node as { children?: unknown }).children;
  return extractAllText(children);
}

describe("ExcelPreview", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    if (renderer) {
      await act(() => renderer?.unmount());
      renderer = null;
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders workbook sheet names, column headers, and cell values", async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["Item", "Price", "Qty"],
      ["Apple", 100, 5],
      ["Banana", 200, 3],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "Financials");
    const data = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

    await act(async () => {
      renderer = create(<ExcelPreview name="report.xlsx" data={data} />);
    });

    const fullText = extractAllText(renderer!.toJSON());

    expect(fullText).toContain("Financials");
    expect(fullText).toContain("Item");
    expect(fullText).toContain("Price");
    expect(fullText).toContain("Apple");
    expect(fullText).toContain("100");
    expect(fullText).toContain("Banana");
    expect(fullText).toContain("200");
  });

  it("handles empty sheet gracefully", async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([]);
    XLSX.utils.book_append_sheet(wb, ws, "EmptySheet");
    const data = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

    await act(async () => {
      renderer = create(<ExcelPreview name="empty.xlsx" data={data} />);
    });

    const fullText = extractAllText(renderer!.toJSON());

    expect(fullText).toContain("EmptySheet");
    expect(fullText).toContain("This sheet is empty.");
  });
});

describe("PowerPointPreview", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    if (renderer) {
      await act(() => renderer?.unmount());
      renderer = null;
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders presentation slides, slide title, and text runs", async () => {
    const zip = new JSZip();
    zip.file(
      "ppt/presentation.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldSz cx="9144000" cy="5143500"/>
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId1"/>
  </p:sldIdLst>
</p:presentation>`,
    );

    zip.file(
      "ppt/_rels/presentation.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
    );

    zip.file(
      "ppt/slides/slide1.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="Title 1"/>
          <p:nvPr><p:ph type="title"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="100000" y="100000"/><a:ext cx="8000000" cy="1000000"/></a:xfrm>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:p>
            <a:r>
              <a:rPr sz="4000" b="1"/>
              <a:t>Quarterly Growth Review</a:t>
            </a:r>
          </a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="3" name="Body 1"/>
          <p:nvPr/>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="100000" y="1500000"/><a:ext cx="8000000" cy="3000000"/></a:xfrm>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:p>
            <a:r><a:t>Revenue is up by 150%.</a:t></a:r>
          </a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`,
    );

    const data = await zip.generateAsync({ type: "uint8array" });

    await act(async () => {
      renderer = create(<PowerPointPreview name="deck.pptx" data={data} />);
    });

    // Wait for async ZIP and slide parsing to complete
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const fullText = extractAllText(renderer!.toJSON());

    expect(fullText).toContain("Quarterly Growth Review");
    expect(fullText).toContain("Revenue is up by 150%.");
    expect(fullText).toContain("1 / 1");
    expect(fullText).toContain("Slide 1");
    expect(fullText).toContain("1 slide");
  });
});
