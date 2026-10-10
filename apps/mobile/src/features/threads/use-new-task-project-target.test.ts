import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => projects,
  useServerConfigs: () => configs,
}));
vi.mock("../../state/project-grouping", () => ({
  useMobileProjectGroupingSettings: () => ({
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
  }),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [mac, pad].map((environmentId) => ({
      environmentId,
      connectionState: "connected",
    })),
  }),
}));

import { useNewTaskProjectTarget } from "./use-new-task-project-target";

const mac = EnvironmentId.make("mac");
const pad = EnvironmentId.make("pad");
function makeProject(
  environmentId: EnvironmentId,
  id: string,
  repository: string,
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: repository,
    workspaceRoot: `/projects/${repository}`,
    repositoryIdentity: {
      canonicalKey: repository,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: `https://example.com/${repository}.git`,
      },
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}
const macProject = makeProject(mac, "mac-project", "repo");
const padProject = makeProject(pad, "pad-project", "repo");
const otherProject = makeProject(mac, "other-project", "other-repo");
const projects = [macProject, padProject, otherProject];
const configs = new Map([
  [
    mac,
    { settings: { projectSettingsOverrides: { [macProject.id]: { defaultEnvironmentId: pad } } } },
  ],
  [pad, { settings: { projectSettingsOverrides: {} } }],
]);

describe("mobile project picker targets", () => {
  it("uses the default for an automatic project pick", () => {
    expect(useNewTaskProjectTarget()(macProject)).toBe(padProject);
  });

  it("preserves the manually selected copy when reselecting its logical project", () => {
    expect(
      useNewTaskProjectTarget()(padProject, {
        manualProjectRef: scopeProjectRef(mac, macProject.id),
      }),
    ).toBe(macProject);
  });

  it("releases a manual choice when selecting another logical project", () => {
    expect(
      useNewTaskProjectTarget()(macProject, {
        manualProjectRef: scopeProjectRef(mac, otherProject.id),
      }),
    ).toBe(padProject);
  });
});
