import { describe, expect, it } from "vite-plus/test";

import {
  claimWorkspaceBasenameLookup,
  nestedWorkspaceLookupPath,
  pickNestedWorkspaceMatch,
  pickWorkspaceBasenameMatch,
} from "@t3tools/client-runtime/workspace-basename-lookup";

describe("pickWorkspaceBasenameMatch", () => {
  const entries = [
    { path: "apps/web/src/components/ChatView.test.tsx", kind: "file" as const },
    { path: "apps/web/src/components/ChatView.tsx", kind: "file" as const },
  ];

  it("takes the first exact filename match, not the closest fuzzy one", () => {
    expect(pickWorkspaceBasenameMatch("ChatView.tsx", entries)).toBe(
      "apps/web/src/components/ChatView.tsx",
    );
  });

  // regression: #6297 a bare filename resolves to a file, never a same-named directory
  it("ignores directories", () => {
    expect(
      pickWorkspaceBasenameMatch("components", [
        { path: "apps/web/src/components", kind: "directory" },
        { path: "apps/web/src/components/components", kind: "file" },
      ]),
    ).toBe("apps/web/src/components/components");
  });

  it("prefers the exactly-cased file over a case-only twin", () => {
    expect(
      pickWorkspaceBasenameMatch("foo.ts", [
        { path: "src/Foo.ts", kind: "file" },
        { path: "src/foo.ts", kind: "file" },
      ]),
    ).toBe("src/foo.ts");
  });

  it("falls back to case-insensitive when only the casing differs", () => {
    expect(pickWorkspaceBasenameMatch("chatview.tsx", entries)).toBe(
      "apps/web/src/components/ChatView.tsx",
    );
  });

  it("returns null when the case-insensitive fallback is ambiguous", () => {
    expect(
      pickWorkspaceBasenameMatch("FOO.ts", [
        { path: "src/Foo.ts", kind: "file" },
        { path: "src/foo.ts", kind: "file" },
      ]),
    ).toBeNull();
  });
});

describe("nestedWorkspaceLookupPath", () => {
  it("keeps a plain subfolder path, without a leading ./", () => {
    expect(nestedWorkspaceLookupPath("tests/sandbox/test_x.py")).toBe("tests/sandbox/test_x.py");
    expect(nestedWorkspaceLookupPath("./phase2/A-findings.md")).toBe("phase2/A-findings.md");
  });

  it("rejects references that leave the workspace or name a host", () => {
    for (const reference of [
      "README.md",
      "../sibling/a.md",
      "docs/../../a.md",
      "~/notes/a.md",
      ".///attacker.example/share/x.md",
      String.raw`.\\\attacker.example\share\x.md`,
      "./C:/Windows/win.ini",
    ]) {
      expect(nestedWorkspaceLookupPath(reference)).toBeNull();
    }
  });
});

describe("pickNestedWorkspaceMatch", () => {
  it("picks the one file whose path ends with every segment of the reference", () => {
    expect(
      pickNestedWorkspaceMatch("src/foo.ts", "/work", [
        { path: "src/foo.ts", kind: "file" },
        { path: "frontend/xsrc/foo.ts", kind: "file" },
        { path: "backend/src/foo.tsx", kind: "file" },
        { path: "backend/src/foo.ts", kind: "file" },
      ]),
    ).toBe("backend/src/foo.ts");
  });

  it("does not guess between repositories holding the same path", () => {
    expect(
      pickNestedWorkspaceMatch("docs/guide.md", "/work", [
        { path: "backend/docs/guide.md", kind: "file" },
        { path: "frontend/docs/guide.md", kind: "file" },
      ]),
    ).toBeNull();
  });

  it("ignores case only in Windows workspaces", () => {
    const entries = [{ path: "Backend\\Src\\Foo.ts", kind: "file" as const }];
    expect(pickNestedWorkspaceMatch("src/foo.ts", "C:\\work", entries)).toBe(
      "Backend\\Src\\Foo.ts",
    );
    expect(pickNestedWorkspaceMatch("src/foo.ts", "/work", entries)).toBeNull();
  });
});

describe("claimWorkspaceBasenameLookup", () => {
  it("keeps only the newest claim, whatever order the lookups settle in", () => {
    const first = claimWorkspaceBasenameLookup();
    const second = claimWorkspaceBasenameLookup();

    expect(second()).toBe(true);
    expect(first()).toBe(false);
  });
});
