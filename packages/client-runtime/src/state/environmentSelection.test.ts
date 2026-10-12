import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveEnvironmentSelection,
  selectProjectsForEnvironment,
  type EnvironmentSelection,
  type EnvironmentSelectionCandidate,
  type ResolvedEnvironmentSelection,
} from "./environmentSelection.ts";
import type { EnvironmentProject } from "./models.ts";
import { buildProjectGroups } from "./projectGrouping.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const envGone = EnvironmentId.make("env-gone");
const envOff = EnvironmentId.make("env-off");

const catalog: EnvironmentSelectionCandidate[] = [
  { environmentId: envA, enabled: true, online: true },
  { environmentId: envB, enabled: true, online: false },
  { environmentId: envOff, enabled: false, online: false },
];

const repositoryIdentity = {
  canonicalKey: "github.com/t3tools/t3code",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/t3tools/t3code.git",
  },
  provider: "github",
  owner: "t3tools",
  name: "t3code",
};

function project(
  environmentId: EnvironmentId,
  id: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const one = (environmentId: EnvironmentId): EnvironmentSelection => ({
  kind: "one",
  environmentId,
});

describe("resolveEnvironmentSelection", () => {
  const projects = [project(envA, "on-a"), project(envB, "on-b")];
  const cases: ReadonlyArray<{
    name: string;
    selection: EnvironmentSelection;
    isReady: boolean;
    resolved: ResolvedEnvironmentSelection;
    visible: string[];
  }> = [
    {
      name: "pending keeps a chosen environment narrowed instead of broadening",
      selection: one(envB),
      isReady: false,
      resolved: { status: "pending", environmentId: envB },
      visible: ["on-b"],
    },
    {
      name: "pending all shows everything without resetting",
      selection: { kind: "all" },
      isReady: false,
      resolved: { status: "pending", environmentId: null },
      visible: ["on-a", "on-b"],
    },
    {
      name: "all lists enabled environments only",
      selection: { kind: "all" },
      isReady: true,
      resolved: { status: "all", environmentIds: [envA, envB] },
      visible: ["on-a", "on-b"],
    },
    {
      name: "active online",
      selection: one(envA),
      isReady: true,
      resolved: { status: "active", environmentId: envA, online: true },
      visible: ["on-a"],
    },
    {
      name: "active offline keeps the cached projects",
      selection: one(envB),
      isReady: true,
      resolved: { status: "active", environmentId: envB, online: false },
      visible: ["on-b"],
    },
    {
      name: "missing (removed) never widens",
      selection: one(envGone),
      isReady: true,
      resolved: { status: "missing", environmentId: envGone },
      visible: [],
    },
    {
      name: "missing (switched off) never widens",
      selection: one(envOff),
      isReady: true,
      resolved: { status: "missing", environmentId: envOff },
      visible: [],
    },
  ];

  it.each(cases)("$name", (testCase) => {
    const resolved = resolveEnvironmentSelection(testCase.selection, catalog, testCase.isReady);
    expect(resolved).toEqual(testCase.resolved);
    expect(selectProjectsForEnvironment(projects, resolved).map((p) => p.id)).toEqual(
      testCase.visible,
    );
  });

  it("returns the same list when nothing is narrowed", () => {
    const resolved = resolveEnvironmentSelection({ kind: "all" }, catalog, true);
    expect(selectProjectsForEnvironment(projects, resolved)).toBe(projects);
  });
});

describe("grouping after the environment filter", () => {
  it("builds a group whose members, refs, label and representative all come from the selected environment", () => {
    const onA = project(envA, "a-checkout", { title: "Checkout on A" });
    const onB = project(envB, "b-checkout", { title: "Checkout on B" });
    const resolved = resolveEnvironmentSelection(one(envA), catalog, true);

    const groups = buildProjectGroups({
      projects: selectProjectsForEnvironment([onB, onA], resolved),
      settings: {
        sidebarProjectGroupingMode: "repository",
        sidebarProjectGroupingOverrides: {},
      },
      // The primary environment would win the representative without the filter.
      preferredEnvironmentId: envB,
    });

    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.members.map((member) => member.project.environmentId)).toEqual([envA]);
    expect(group.memberProjectRefs).toEqual([{ environmentId: envA, projectId: onA.id }]);
    expect(group.representative).toBe(onA);
    expect(group.label).toBe("Checkout on A");
  });

  it("keeps the logical key the unfiltered group had", () => {
    const projects = [project(envA, "a"), project(envB, "b")];
    const settings = {
      sidebarProjectGroupingMode: "repository" as const,
      sidebarProjectGroupingOverrides: {},
    };
    const all = buildProjectGroups({ projects, settings });
    const narrowed = buildProjectGroups({
      projects: selectProjectsForEnvironment(
        projects,
        resolveEnvironmentSelection(one(envA), catalog, true),
      ),
      settings,
    });
    expect(narrowed.map((group) => group.key)).toEqual(all.map((group) => group.key));
  });
});
