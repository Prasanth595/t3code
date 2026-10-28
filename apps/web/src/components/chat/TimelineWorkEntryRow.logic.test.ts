import { describe, expect, it } from "vite-plus/test";
import { parseMarkdownWithMath } from "@t3tools/shared/markdownMath";
import { remarkThoughtPreview, thoughtPreviewSource } from "./TimelineWorkEntryRow.logic";

describe("thoughtPreviewSource", () => {
  it("keeps short traces intact", () => {
    expect(thoughtPreviewSource("Checking the parser.")).toBe("Checking the parser.");
  });

  it("cuts long traces at a word boundary", () => {
    const source = thoughtPreviewSource(`${"word ".repeat(1_000)}tail`);
    expect(source.length).toBeLessThanOrEqual(2_000);
    expect(source.endsWith("word")).toBe(true);
  });

  it("keeps the text when the only whitespace is leading", () => {
    const source = thoughtPreviewSource(`\n\n${"字".repeat(2_001)}`);
    expect(source).toBe(`\n\n${"字".repeat(1_998)}`);
  });

  it("never cuts inside an emoji when the trace has no whitespace", () => {
    expect(thoughtPreviewSource(`${"a".repeat(1_999)}🙂${"b".repeat(10)}`)).toBe("a".repeat(1_999));
  });
});

describe("remarkThoughtPreview", () => {
  it("flattens a long trace into one collapsed text run", () => {
    const tree = parseMarkdownWithMath(`**Plan**\n\n${"Read `a.ts`  and *b*.\n\n".repeat(2_000)}`);
    remarkThoughtPreview("Thought")(tree);
    expect(tree.children).toHaveLength(1);
    const [text] = tree.children;
    expect(text?.type === "text" && text.value.startsWith("Plan Read a.ts and b. Read")).toBe(true);
    expect(text?.type === "text" && /\s{2}/.test(text.value)).toBe(false);
  });

  it("falls back when the trace has no visible text", () => {
    const tree = parseMarkdownWithMath("<b></b>");
    remarkThoughtPreview("Thought")(tree);
    expect(tree.children).toEqual([{ type: "text", value: "Thought" }]);
  });
});
