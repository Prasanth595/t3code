import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { diffChangeTargets, stepDiffChange } from "./diffFocusNavigation.logic";

const PATCH = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,6 +1,6 @@
 import a from "a";
-const one = 1;
+const one = 2;
 const two = 2;
 const three = 3;
-const four = 4;
 const five = 5;
+const six = 6;
@@ -40,3 +40,4 @@ function tail() {
   return 1;
+  // done
 }
`;

describe("diffChangeTargets", () => {
  it("lands on the first changed line of each change block, preferring the new side", () => {
    const [file] = parsePatchFiles(PATCH)[0]?.files ?? [];
    expect(file && diffChangeTargets(file)).toEqual([
      { side: "additions", lineNumber: 2 },
      { side: "deletions", lineNumber: 5 },
      { side: "additions", lineNumber: 6 },
      { side: "additions", lineNumber: 41 },
    ]);
  });
});

describe("stepDiffChange", () => {
  const counts = [2, 0, 3];

  it("moves into the next file with changes, skipping files without any", () => {
    expect(stepDiffChange({ fileIndex: 0, changeIndex: 1 }, counts, 1)).toEqual({
      fileIndex: 2,
      changeIndex: 0,
    });
  });

  it("moves back into the previous file's last change", () => {
    expect(stepDiffChange({ fileIndex: 2, changeIndex: 0 }, counts, -1)).toEqual({
      fileIndex: 0,
      changeIndex: 1,
    });
  });

  it("starts from the top of a file", () => {
    expect(stepDiffChange({ fileIndex: 2, changeIndex: -1 }, counts, 1)).toEqual({
      fileIndex: 2,
      changeIndex: 0,
    });
  });

  it("stays put at either end of the diff", () => {
    expect(stepDiffChange({ fileIndex: 2, changeIndex: 2 }, counts, 1)).toEqual({
      fileIndex: 2,
      changeIndex: 2,
    });
    expect(stepDiffChange({ fileIndex: 0, changeIndex: 0 }, counts, -1)).toEqual({
      fileIndex: 0,
      changeIndex: 0,
    });
  });
});
