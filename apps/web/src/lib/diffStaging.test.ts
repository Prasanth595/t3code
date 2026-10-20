import type { FileDiffMetadata } from "@pierre/diffs";
import type { ReviewDiffPreviewSource } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fileDiffStagingPaths, sourceStagingPaths } from "./diffStaging";

const source = (files?: ReviewDiffPreviewSource["files"]): ReviewDiffPreviewSource => ({
  id: "unstaged",
  kind: "unstaged",
  title: "Changes",
  baseRef: null,
  headRef: null,
  diff: "",
  diffHash: "hash",
  truncated: files === undefined,
  ...(files ? { files } : {}),
});

describe("fileDiffStagingPaths", () => {
  it("stages both sides of a rename", () => {
    expect(
      fileDiffStagingPaths({ name: "src/new.ts", prevName: "src/old.ts" } as FileDiffMetadata),
    ).toEqual(["src/new.ts", "src/old.ts"]);
    expect(fileDiffStagingPaths({ name: "README.md" } as FileDiffMetadata)).toEqual(["README.md"]);
  });
});

describe("sourceStagingPaths", () => {
  it("covers files a truncated preview has not rendered", () => {
    expect(
      sourceStagingPaths(
        source([
          { path: "a.ts", previousPath: null, additions: 1, deletions: 0 },
          { path: "src/new.ts", previousPath: "src/old.ts", additions: 0, deletions: 0 },
        ]),
        [{ name: "a.ts" } as FileDiffMetadata],
      ),
    ).toEqual(["a.ts", "src/new.ts", "src/old.ts"]);
  });

  it("falls back to the rendered files without file stats", () => {
    expect(sourceStagingPaths(source(), [{ name: "a.ts" } as FileDiffMetadata])).toEqual(["a.ts"]);
  });
});
