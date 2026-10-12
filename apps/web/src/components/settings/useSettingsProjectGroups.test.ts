import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Project } from "../../types";
import { buildSettingsProjectGroups } from "./useSettingsProjectGroups";

const laptopId = EnvironmentId.make("laptop");
const serverId = EnvironmentId.make("server");

function project(id: string, environmentId: EnvironmentId): Project {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: id,
    workspaceRoot: `/repos/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
    scripts: [],
  };
}

describe("buildSettingsProjectGroups", () => {
  const projects = [project("api", laptopId), project("notes", serverId)];
  const input = {
    projects,
    settings: {
      sidebarProjectGroupingMode: "separate" as const,
      sidebarProjectGroupingOverrides: {},
    },
    primaryEnvironmentId: laptopId,
    environments: [
      { environmentId: laptopId, label: "Laptop" },
      // Narrowing ignores enabled/online state: Settings lists whatever projects it is given.
      { environmentId: serverId, label: "Server" },
    ],
  };

  it("keeps a disabled environment's projects reachable when Settings names it", () => {
    expect(
      buildSettingsProjectGroups({ ...input, machine: serverId }).map((group) => group.displayName),
    ).toEqual(["notes"]);
  });

  it("narrows to the named environment only", () => {
    expect(
      buildSettingsProjectGroups({ ...input, machine: laptopId }).map((group) => group.displayName),
    ).toEqual(["api"]);
    expect(
      buildSettingsProjectGroups({ ...input, machine: undefined }).map(
        (group) => group.displayName,
      ),
    ).toEqual(["api", "notes"]);
  });
});
