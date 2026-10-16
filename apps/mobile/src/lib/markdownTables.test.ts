import { describe, expect, it } from "vite-plus/test";
import { markdownWithTableBreaks } from "./markdownDocument";

const TABLE = "| Company | Fit |\n|---|---|\n| Acme | A |";

describe("tables after a line of text", () => {
  it("separates a table from the paragraph it interrupts", () => {
    expect(markdownWithTableBreaks(`Lead-in\n${TABLE}`)).toBe(`Lead-in\n\n${TABLE}`);
    expect(markdownWithTableBreaks(`First line\nsecond line\n${TABLE}\n\nAfter`)).toBe(
      `First line\nsecond line\n\n${TABLE}\n\nAfter`,
    );
  });

  it("separates every interrupting table", () => {
    expect(markdownWithTableBreaks(`One\n${TABLE}\n\nTwo\n${TABLE}`)).toBe(
      `One\n\n${TABLE}\n\nTwo\n\n${TABLE}`,
    );
  });

  it("keeps the blank line inside the blockquote that holds the table", () => {
    const quoted = (text: string) =>
      text
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    expect(markdownWithTableBreaks(quoted(`Lead-in\n${TABLE}`))).toBe(
      quoted(`Lead-in\n\n${TABLE}`),
    );
  });

  it("separates a table nested in a list item", () => {
    const indented = TABLE.replace(/^/gm, "  ");
    expect(markdownWithTableBreaks(`- Lead-in\n${indented}`)).toBe(`- Lead-in\n\n${indented}`);
  });

  it("leaves tables that already stand alone and pipes that are not tables", () => {
    for (const markdown of [
      TABLE,
      `Lead-in\n\n${TABLE}`,
      `# Heading\n\n${TABLE}`,
      `Lead-in\n\`\`\`md\n${TABLE}\n\`\`\``,
      "a | b\nnot a table",
    ]) {
      expect(markdownWithTableBreaks(markdown)).toBe(markdown);
    }
  });
});
