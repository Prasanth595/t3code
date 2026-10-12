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
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeEnvironmentLabel,
} from "./settingsScopeAxis";

const first = {
  environmentId: EnvironmentId.make("first"),
  label: "Development",
  displayUrl: "https://first.example.com",
};
const second = {
  environmentId: EnvironmentId.make("second"),
  label: "Development",
  displayUrl: "https://second.example.com",
};

describe("settings scope environment labels", () => {
  it("distinguishes same-name environments by address", () => {
    const environments = [first, second];
    expect(
      environments.map((environment) => settingsScopeEnvironmentLabel(environment, environments)),
    ).toEqual([
      "Development · https://first.example.com",
      "Development · https://second.example.com",
    ]);
  });

  it("falls back to environment IDs when duplicate names have no display URL", () => {
    const environments = [first, second].map((environment) => ({
      ...environment,
      displayUrl: null,
    }));
    expect(
      environments.map((environment) => settingsScopeEnvironmentLabel(environment, environments)),
    ).toEqual(["Development · first", "Development · second"]);
  });

  it("keeps unique names compact and removes disambiguation after a rename", () => {
    expect(settingsScopeEnvironmentLabel(first, [first])).toBe("Development");
    expect(settingsScopeEnvironmentLabel(first, [first, { ...second, label: "Production" }])).toBe(
      "Development",
    );
  });
});

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
});
