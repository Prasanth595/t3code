import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import {
  environmentAxisValue,
  projectAxisValue,
  projectScopeMenuEntries,
  resolveSettingsScopeSearch,
  selectEnvironmentAxis,
  selectProjectAxis,
} from "./settingsScopeAxis";

describe("settings scope axes", () => {
  it("maps each axis to its search key and back", () => {
    expect(projectAxisValue({})).toBe("all");
    expect(projectAxisValue({ project: "app" })).toBe("app");
    expect(selectProjectAxis({ machine: "second" }, "app")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis({ machine: "second", project: "app" }, "all")).toEqual({
      machine: "second",
    });
    expect(selectEnvironmentAxis({ project: "app" }, "first")).toEqual({
      project: "app",
      machine: "first",
    });
    expect(selectEnvironmentAxis({ project: "app", machine: "first" }, "all")).toEqual({
      project: "app",
    });
  });

  it("drops a checkout narrowing from older links when either axis changes", () => {
    const checkout = {
      project: "app",
      checkout: "app@first",
      machine: "first",
    };
    expect(selectEnvironmentAxis(checkout, "second")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis(checkout, "app")).toEqual({
      project: "app",
      machine: "first",
    });
  });
});

describe("environmentAxisValue", () => {
  it("shows the checkout's environment for a legacy checkout link", () => {
    expect(environmentAxisValue({ project: "p", checkout: "c" }, "laptop")).toBe("laptop");
    expect(environmentAxisValue({ project: "p" }, null)).toBe("all");
    expect(environmentAxisValue({ machine: "desk" }, "laptop")).toBe("desk");
  });
});

describe("settings scope project menu", () => {
  const fedora = {
    environmentId: EnvironmentId.make("fedora"),
    label: "fedora",
    displayUrl: null,
  };
  const laptop = {
    environmentId: EnvironmentId.make("laptop"),
    label: "laptop",
    displayUrl: null,
  };
  const environments = [fedora, laptop];

  function member(id: string, environmentId: EnvironmentId, workspaceRoot: string) {
    return {
      id: ProjectId.make(id),
      environmentId,
      title: id,
      workspaceRoot,
      physicalProjectKey: `${environmentId}:${workspaceRoot}`,
      environmentLabel: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-11T00:00:00.000Z",
      updatedAt: "2026-10-11T00:00:00.000Z",
    } satisfies SidebarProjectGroupMember;
  }

  function group(
    projectKey: string,
    displayName: string,
    members: readonly SidebarProjectGroupMember[],
  ): SidebarProjectSnapshot {
    return {
      ...members[0]!,
      projectKey,
      displayName,
      memberProjects: members,
      memberProjectRefs: members.map((project) => ({
        environmentId: project.environmentId,
        projectId: project.id,
      })),
      groupedProjectCount: members.length,
      environmentPresence: "mixed",
      allRemoteMembersAreDesktopLocal: false,
      allRemoteMembersAreWsl: false,
      remoteEnvironmentLabels: [],
    };
  }

  const api = group("api", "api", [member("api", fedora.environmentId, "/src/api")]);
  const shared = group("shared", "shared", [
    member("shared-laptop", laptop.environmentId, "C:\\code\\shared"),
    member("shared-fedora", fedora.environmentId, "/src/shared"),
  ]);
  const notes = group("notes", "notes", [member("notes", laptop.environmentId, "C:\\notes")]);
  const groups = [api, shared, notes];

  const summarize = (entries: ReturnType<typeof projectScopeMenuEntries<typeof fedora>>) =>
    entries.map((entry) => ({
      project: entry.group.projectKey,
      environments: entry.environments.map((environment) => environment.label),
    }));

  it("lists only projects with a checkout on the selected environment, named by it", () => {
    expect(summarize(projectScopeMenuEntries(groups, environments, fedora.environmentId))).toEqual([
      { project: "api", environments: ["fedora"] },
      { project: "shared", environments: ["fedora"] },
    ]);
  });

  it("names each project's environments when every environment is in scope", () => {
    expect(summarize(projectScopeMenuEntries(groups, environments, undefined))).toEqual([
      { project: "api", environments: ["fedora"] },
      { project: "shared", environments: ["fedora", "laptop"] },
      { project: "notes", environments: ["laptop"] },
    ]);
  });

  it("omits environment names when only one environment exists", () => {
    expect(summarize(projectScopeMenuEntries([api], [fedora], undefined))).toEqual([
      { project: "api", environments: [] },
    ]);
  });

  it("tells same-name projects apart by environment, never by folder", () => {
    const onFedora = group("astrabit-fedora", "Astrabit", [
      member("fedora", fedora.environmentId, "/home/me/astrabit"),
    ]);
    const onLaptop = group("astrabit-laptop", "Astrabit", [
      member("laptop", laptop.environmentId, "C:\\astrabit"),
    ]);
    expect(
      summarize(projectScopeMenuEntries([onFedora, onLaptop], environments, undefined)),
    ).toEqual([
      { project: "astrabit-fedora", environments: ["fedora"] },
      { project: "astrabit-laptop", environments: ["laptop"] },
    ]);
  });

  describe("resolveSettingsScopeSearch", () => {
    const connected = environments.map((environment) => ({
      ...environment,
      connection: { phase: "connected" as const },
    }));
    // Narrowing regroups, so a narrowed group is a different object from the full one.
    const groupsFor = (machine: string | undefined) =>
      machine === undefined
        ? groups
        : groups.flatMap((candidate) => {
            const members = candidate.memberProjects.filter(
              (entry) => entry.environmentId === machine,
            );
            return members.length === 0
              ? []
              : [group(candidate.projectKey, candidate.displayName, members)];
          });

    it("groups provider settings by the machine it picks for a project", () => {
      const { search, groups: resolved } = resolveSettingsScopeSearch({
        rawSearch: { project: "shared" },
        singleEnvironment: true,
        environments: connected,
        primaryEnvironmentId: laptop.environmentId,
        groupsFor,
      });
      expect(search).toEqual({ project: "shared", machine: laptop.environmentId });
      expect(
        resolved.map((entry) => ({
          project: entry.projectKey,
          members: entry.memberProjects.map((project) => project.environmentId),
        })),
      ).toEqual([
        { project: "shared", members: [laptop.environmentId] },
        { project: "notes", members: [laptop.environmentId] },
      ]);
    });

    it("still offers every environment's checkouts once a machine narrows the groups", () => {
      const { allGroups } = resolveSettingsScopeSearch({
        rawSearch: { project: "shared", machine: laptop.environmentId },
        singleEnvironment: false,
        environments: connected,
        primaryEnvironmentId: laptop.environmentId,
        groupsFor,
      });
      expect(allGroups).toBe(groups);
    });

    it("keeps every environment's groups when no machine is chosen", () => {
      const { search, groups: resolved } = resolveSettingsScopeSearch({
        rawSearch: { project: "shared" },
        singleEnvironment: false,
        environments: connected,
        primaryEnvironmentId: laptop.environmentId,
        groupsFor,
      });
      expect(search).toEqual({ project: "shared" });
      expect(resolved).toBe(groups);
    });
  });
});
