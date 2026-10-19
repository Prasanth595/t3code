import { describe, expect, it, vi } from "vite-plus/test";

import {
  claimWorkspaceBasenameLookup,
  findWorkspaceFileMatch,
  needsWorkspaceBasenameLookup,
  pickWorkspaceBasenameMatch,
  type WorkspaceEntryCandidate,
} from "./workspaceBasenameLookup";

describe("needsWorkspaceBasenameLookup", () => {
  it("flags bare filenames", () => {
    expect(needsWorkspaceBasenameLookup("ChatView.tsx")).toBe(true);
    expect(needsWorkspaceBasenameLookup("Makefile")).toBe(true);
  });

  it("leaves anything with a directory alone", () => {
    expect(needsWorkspaceBasenameLookup("apps/web/src/components/ChatView.tsx")).toBe(false);
    expect(needsWorkspaceBasenameLookup("apps\\web\\ChatView.tsx")).toBe(false);
    expect(needsWorkspaceBasenameLookup(".")).toBe(false);
    expect(needsWorkspaceBasenameLookup("..")).toBe(false);
    expect(needsWorkspaceBasenameLookup("   ")).toBe(false);
  });
});

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

  it("returns null when nothing matches the name", () => {
    expect(pickWorkspaceBasenameMatch("ChatView.tsx", [])).toBeNull();
    expect(
      pickWorkspaceBasenameMatch("ChatView.tsx", [
        { path: "apps/web/src/components/ChatHeader.tsx", kind: "file" },
      ]),
    ).toBeNull();
  });
});

describe("findWorkspaceFileMatch", () => {
  const nestedPlan: WorkspaceEntryCandidate = {
    path: "BudgetLens/docs/plan.md",
    kind: "file",
  };
  const lookup = (
    literalExists: boolean,
    entries: ReadonlyArray<WorkspaceEntryCandidate> | null,
    truncated = false,
  ) => ({
    literalExists: vi.fn(async () => literalExists),
    searchFiles: vi.fn(async (_query: string) => (entries ? { entries, truncated } : null)),
  });

  it("keeps the literal path without searching unless it is known to be missing", async () => {
    // The literal file may be ignored by the index; metadata uncertainty also keeps it.
    const deps = lookup(true, [nestedPlan]);
    await expect(findWorkspaceFileMatch("docs/plan.md", deps)).resolves.toBeNull();
    expect(deps.searchFiles).not.toHaveBeenCalled();
  });

  it("finds a unique nested file when the literal path is missing", async () => {
    const deps = lookup(false, [nestedPlan]);
    await expect(findWorkspaceFileMatch("docs/plan.md", deps)).resolves.toBe(nestedPlan.path);
    expect(deps.searchFiles).toHaveBeenCalledWith("docs/plan.md");
  });

  it("prefers exact case, then accepts a unique case-folded suffix across separators", async () => {
    const caseTwin: WorkspaceEntryCandidate = { path: "Other/Docs/Plan.md", kind: "file" };
    await expect(
      findWorkspaceFileMatch("docs/plan.md", lookup(false, [caseTwin, nestedPlan])),
    ).resolves.toBe(nestedPlan.path);
    await expect(
      findWorkspaceFileMatch("DOCS\\PLAN.MD", lookup(false, [nestedPlan])),
    ).resolves.toBe(nestedPlan.path);
    await expect(
      findWorkspaceFileMatch(
        "docs/plan.md",
        lookup(false, [{ ...nestedPlan, path: "app\\docs\\plan.md" }]),
      ),
    ).resolves.toBe("app\\docs\\plan.md");
  });

  it("keeps the literal path for ambiguous suffixes, partial segments, or directories", async () => {
    await expect(
      findWorkspaceFileMatch(
        "docs/plan.md",
        lookup(false, [nestedPlan, { path: "Other/docs/plan.md", kind: "file" }]),
      ),
    ).resolves.toBeNull();
    await expect(
      findWorkspaceFileMatch(
        "DOCS/PLAN.MD",
        lookup(false, [nestedPlan, { path: "Other/Docs/Plan.md", kind: "file" }]),
      ),
    ).resolves.toBeNull();
    await expect(
      findWorkspaceFileMatch(
        "docs/plan.md",
        lookup(false, [
          { path: "app/mydocs/plan.md", kind: "file" },
          { path: "app/docs/plan.md", kind: "directory" },
        ]),
      ),
    ).resolves.toBeNull();
  });

  it("rejects truncated suffix results even when a fuzzy file follows the only match", async () => {
    // Truncation also signals an incomplete scan, so page order cannot prove uniqueness.
    const fuzzy: WorkspaceEntryCandidate = { path: "docs/plan.old.md", kind: "file" };
    await expect(
      findWorkspaceFileMatch("docs/plan.md", lookup(false, [nestedPlan], true)),
    ).resolves.toBeNull();
    await expect(
      findWorkspaceFileMatch("docs/plan.md", lookup(false, [nestedPlan, fuzzy], true)),
    ).resolves.toBeNull();
  });

  it("keeps the literal path when search fails or returns no files", async () => {
    await expect(findWorkspaceFileMatch("docs/plan.md", lookup(false, null))).resolves.toBeNull();
    await expect(findWorkspaceFileMatch("docs/plan.md", lookup(false, []))).resolves.toBeNull();
  });

  it("still resolves bare filenames without checking the literal, even with truncated duplicates", async () => {
    const deps = lookup(true, [nestedPlan, { path: "Other/plan.md", kind: "file" }], true);
    await expect(findWorkspaceFileMatch("plan.md", deps)).resolves.toBe(nestedPlan.path);
    expect(deps.literalExists).not.toHaveBeenCalled();
    expect(deps.searchFiles).toHaveBeenCalledWith("plan.md");
  });
});

describe("claimWorkspaceBasenameLookup", () => {
  it("keeps only the newest claim, whatever order the lookups settle in", () => {
    const first = claimWorkspaceBasenameLookup();
    const second = claimWorkspaceBasenameLookup();

    expect(second()).toBe(true);
    expect(first()).toBe(false);
  });

  it("stays valid while it is the only claim", () => {
    const only = claimWorkspaceBasenameLookup();
    expect(only()).toBe(true);
  });
});
