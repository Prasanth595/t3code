import { describe, expect, it } from "vite-plus/test";
import { getRenderablePatch, resolveFileDiffPath } from "./diffRendering";
import { toolCallPatch } from "./toolCallDiff";

describe("toolCallPatch", () => {
  it("renders recorded hunks without reading a repository, including renamed paths", () => {
    for (const changes of [
      undefined,
      [{ operation: "update", oldPath: "old.ts", path: "new.ts" }],
    ]) {
      const patch = toolCallPatch({
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
          toolCallPatch({
            fileName: "file with spaces.ts",
            diffStr: `first\nsecond${ending}`,
            changes: [{ operation, path: "file with spaces.ts" }],
          }),
        );
        expect(rendered?.kind).toBe("files");
        if (rendered?.kind !== "files") throw new Error("Expected a file diff");
        expect(resolveFileDiffPath(rendered.files[0]!)).toBe("file with spaces.ts");
        expect(rendered.files[0]!.additionLines).toHaveLength(operation === "add" ? 2 : 0);
        expect(rendered.files[0]!.deletionLines).toHaveLength(operation === "delete" ? 2 : 0);
      }
    }
  });

  it("preserves complete patches and unsupported provider output", () => {
    for (const diffStr of [
      undefined,
      "",
      "provider output",
      "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
    ]) {
      expect(
        toolCallPatch({ fileName: "a.ts", ...(diffStr === undefined ? {} : { diffStr }) }),
      ).toBe(diffStr);
    }
  });
});
