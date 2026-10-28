import { describe, expect, it } from "vite-plus/test";
import { getRenderablePatch, resolveFileDiffPath } from "./diffRendering";
import { toolCallDiff } from "./toolCallDiff";

describe("toolCallDiff", () => {
  it("renders recorded hunks without reading a repository, including renamed paths", () => {
    for (const changes of [
      undefined,
      [{ operation: "update", oldPath: "old.ts", path: "new.ts" }],
    ]) {
      const { patch } = toolCallDiff({
        fileName: "old.ts",
        diffStr: "@@ -1 +1 @@\n-before\n+after\n",
        ...(changes ? { changes } : {}),
      });
      const rendered = getRenderablePatch(patch);
      expect(rendered?.kind).toBe("files");
      if (rendered?.kind !== "files") throw new Error("Expected a file diff");
      expect(rendered.files).toHaveLength(1);
      expect(resolveFileDiffPath(rendered.files[0]!)).toBe(changes ? "new.ts" : "old.ts");
      expect(rendered.files[0]!.additionLines.join("")).toContain("after");
      expect(rendered.files[0]!.deletionLines.join("")).toContain("before");
    }
  });

  it("renders added and deleted file contents as a file diff", () => {
    for (const operation of ["add", "delete"]) {
      for (const ending of ["", "\n"]) {
        const rendered = getRenderablePatch(
          toolCallDiff({
            fileName: "file with spaces.ts",
            diffStr: `first\nsecond${ending}`,
            changes: [{ operation, path: "file with spaces.ts" }],
          }).patch,
        );
        expect(rendered?.kind).toBe("files");
        if (rendered?.kind !== "files") throw new Error("Expected a file diff");
        expect(resolveFileDiffPath(rendered.files[0]!)).toBe("file with spaces.ts");
        expect(rendered.files[0]!.additionLines).toHaveLength(operation === "add" ? 2 : 0);
        expect(rendered.files[0]!.deletionLines).toHaveLength(operation === "delete" ? 2 : 0);
      }
    }
  });

  it("keeps content-only writes out of the patch and preserves empty recorded content", () => {
    expect(toolCallDiff({ fileName: "a.ts", oldStr: "before", newStr: "" })).toEqual({
      patch: undefined,
      content: [
        { label: "Recorded content before", text: "before" },
        { label: "Recorded content after", text: "" },
      ],
      truncated: false,
    });
    expect(toolCallDiff({ fileName: "a.ts", newStr: "after" }).content).toEqual([
      { label: "Recorded content after", text: "after" },
    ]);
  });

  it("removes transport truncation markers before converting file contents", () => {
    const suffix = "\n… output truncated for transport";
    const diff = toolCallDiff({
      fileName: "a.ts",
      diffStr: `first\nsecond${suffix}`,
      changes: [{ operation: "add", path: "a.ts" }],
    });
    expect(diff.truncated).toBe(true);
    expect(diff.patch).not.toContain("output truncated");
    expect(getRenderablePatch(diff.patch)?.kind).toBe("files");
    expect(toolCallDiff({ fileName: "a.ts", newStr: `content${suffix}` })).toMatchObject({
      content: [{ label: "Recorded content after", text: "content" }],
      truncated: true,
    });
  });

  it("preserves complete patches and unsupported provider output", () => {
    for (const diffStr of [
      undefined,
      "",
      "provider output",
      "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
    ]) {
      expect(
        toolCallDiff({ fileName: "a.ts", ...(diffStr === undefined ? {} : { diffStr }) }).patch,
      ).toBe(diffStr);
    }
  });
});
