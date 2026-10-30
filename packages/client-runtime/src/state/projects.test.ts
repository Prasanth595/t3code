import { describe, expect, it } from "vite-plus/test";

import { isScratchProject } from "./projects.ts";

describe("isScratchProject", () => {
  it.each([null, undefined])(
    "recognises a loaded scratch project when its environment offers no available root (%s)",
    (scratchWorkspaceRoot) => {
      const project = { workspaceRoot: "/remote/scratch", isScratch: true as const };

      expect(isScratchProject(project, scratchWorkspaceRoot)).toBe(true);
    },
  );

  it("recognises raw project records by their configured, normalised path", () => {
    expect(isScratchProject({ workspaceRoot: "/remote/scratch/" }, "/remote/scratch")).toBe(true);
    expect(isScratchProject({ workspaceRoot: "/remote/scratch/work" }, "/remote/scratch")).toBe(
      false,
    );
  });

  it("keeps ordinary projects when no scratch root is available", () => {
    const project = { title: "No project", workspaceRoot: "/repo" };

    expect(isScratchProject(project, null)).toBe(false);
    expect(isScratchProject(project, undefined)).toBe(false);
  });
});
