import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveEnvironmentSelection,
  selectProjectsForEnvironment,
} from "./environmentSelection.ts";
import type { EnvironmentProject } from "./models.ts";
import { buildProjectGroups } from "./projectGrouping.ts";
import {
  projectMachineLabelEnvironments,
  projectMachineLabelParts,
  projectMachineLabelText,
} from "./projectMachineLabel.ts";

const fedora = { environmentId: EnvironmentId.make("fedora"), label: "Fedora" };
const swerve = {
  environmentId: EnvironmentId.make("swerve"),
  label: "SwerveStation",
};
const environments = [fedora, swerve];
const catalog = environments.map((environment) => ({
  environmentId: environment.environmentId,
  enabled: true,
  online: true,
}));

function project(environmentId: EnvironmentId, id: string): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: "Astrabit",
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: {
      canonicalKey: "github.com/astrabit/astrabit",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/astrabit/astrabit.git",
      },
      name: "astrabit",
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

const projects = [
  project(fedora.environmentId, "on-fedora"),
  project(swerve.environmentId, "on-swerve"),
];

function shownLabels(
  selection: Parameters<typeof resolveEnvironmentSelection>[0],
  mode = "name" as const,
) {
  const resolved = resolveEnvironmentSelection(selection, catalog, true);
  const [group] = buildProjectGroups({
    projects: selectProjectsForEnvironment(projects, resolved),
    settings: {
      sidebarProjectGroupingMode: "repository",
      sidebarProjectGroupingOverrides: {},
    },
  });
  return projectMachineLabelEnvironments(
    group!.members.map((member) => member.project.environmentId),
    environments,
    mode,
  ).map((environment) => environment.label);
}

describe("projectMachineLabelEnvironments", () => {
  it("names every machine the project is on when all environments are shown", () => {
    expect(shownLabels({ kind: "all" })).toEqual(["Fedora", "SwerveStation"]);
  });

  it("names only the selected machine when one environment is selected", () => {
    expect(shownLabels({ kind: "one", environmentId: swerve.environmentId })).toEqual([
      "SwerveStation",
    ]);
  });

  it("shows nothing with a single environment", () => {
    expect(projectMachineLabelEnvironments([fedora.environmentId], [fedora], "name")).toEqual([]);
  });

  it("shows nothing when switched off, whatever the filter", () => {
    expect(
      projectMachineLabelEnvironments(
        [fedora.environmentId, swerve.environmentId],
        environments,
        "off",
      ),
    ).toEqual([]);
  });

  it("keeps catalog order regardless of member order", () => {
    expect(
      projectMachineLabelEnvironments(
        [swerve.environmentId, fedora.environmentId],
        environments,
        "icon",
      ).map((environment) => environment.label),
    ).toEqual(["Fedora", "SwerveStation"]);
  });
});

describe("projectMachineLabelParts", () => {
  it("maps each mode to the parts it renders", () => {
    expect(projectMachineLabelParts("name")).toEqual({
      icon: false,
      name: true,
    });
    expect(projectMachineLabelParts("icon")).toEqual({
      icon: true,
      name: false,
    });
    expect(projectMachineLabelParts("icon-name")).toEqual({
      icon: true,
      name: true,
    });
    expect(projectMachineLabelParts("off")).toEqual({
      icon: false,
      name: false,
    });
  });

  it("joins several machine names", () => {
    expect(projectMachineLabelText(["Fedora", "SwerveStation"])).toBe("Fedora, SwerveStation");
  });
});
