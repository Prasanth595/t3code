import { describe, expect, it } from "@effect/vitest";
import { parseGtrCreation } from "./gtrOutput.ts";

describe("gtr creation output", () => {
  it("converts Git Bash drive paths only on Windows", () => {
    const output = "path\t/c/worktrees/test\nbranch\ttest\nhook_status\tdisabled\n";
    expect(parseGtrCreation(output, true)?.path).toBe("c:/worktrees/test");
    expect(parseGtrCreation(output)?.path).toBe("/c/worktrees/test");
  });
  it("decodes escaped paths without treating a literal backslash as another escape", () => {
    expect(
      parseGtrCreation(
        String.raw`path	/C:/work trees/\\project\tcopy\nnext` +
          "\nbranch\tfeature/test\nhook_status\tran\n",
      ),
    ).toEqual({
      path: "/C:/work trees/\\project\tcopy\nnext",
      branch: "feature/test",
      hookStatus: "ran",
    });
  });
  it.each([
    "",
    "path\t/repo\nbranch\ttest\n",
    "log\npath\t/repo\nbranch\ttest\nhook_status\tran\n",
    "path\t/repo\\q\nbranch\ttest\nhook_status\tran\n",
    "path\t/repo\\\nbranch\ttest\nhook_status\tran\n",
    "path\t\nbranch\ttest\nhook_status\tran\n",
    "path\t/repo\nbranch\ttest\nhook_status\tfailed\n",
  ])("rejects malformed output %j", (output) => {
    expect(parseGtrCreation(output)).toBeNull();
  });
});
