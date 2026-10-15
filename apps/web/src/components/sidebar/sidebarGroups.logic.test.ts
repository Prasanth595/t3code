import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type SidebarGroup,
  type SidebarGroups,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import {
  buildSidebarGroupProjectFacts,
  compileSidebarGroups,
  DEFAULT_SIDEBAR_GROUP_ID,
  moveSidebarThreads,
  pruneSidebarGroupAssignments,
  resolveSidebarThreadGroupId,
  sidebarGroupShowsThread,
  sidebarGroupThreadKey,
} from "./sidebarGroups.logic";

const mac = EnvironmentId.make("environment-mac");
const vps = EnvironmentId.make("environment-vps");

// The same repository is a different project on each machine.
const projects = buildSidebarGroupProjectFacts([
  {
    environmentId: mac,
    id: "project-mac",
    repositoryIdentity: {
      canonicalKey: "github.com/yarden-zamir/t3code",
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: "https://x" },
    },
  },
  {
    environmentId: vps,
    id: "project-vps",
    repositoryIdentity: {
      canonicalKey: "github.com/yarden-zamir/t3code",
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: "https://x" },
    },
  },
]);

const thread = (environmentId: EnvironmentId, title: string, projectId = "project-mac") =>
  makeThreadFixture({
    environmentId,
    id: ThreadId.make(title),
    projectId: ProjectId.make(projectId),
    title,
  });

const conductor = thread(mac, "Conductor");
const other = thread(mac, "Fix overlay");
const monitors: SidebarGroup = {
  id: "monitors",
  name: "Monitors",
  rules: [{ field: "title", operator: "is", values: ["conductor"] }],
};
const all: SidebarGroup = {
  id: "all",
  name: "All",
  rules: [{ field: "group", operator: "is_not", values: [] }],
};
const settings = (
  groups: SidebarGroup[],
  assignments: SidebarGroups["assignments"] = {},
): SidebarGroups => ({ groups, assignments });
const groupOf = (subject: typeof conductor, value: SidebarGroups) =>
  resolveSidebarThreadGroupId(subject, compileSidebarGroups(value), projects);

describe("sidebar group resolution", () => {
  it("prefers a drag assignment, then the first matching group, then the default tab", () => {
    const value = settings([monitors], { [sidebarGroupThreadKey(other)]: "monitors" });
    expect(groupOf(other, value)).toBe("monitors");
    expect(groupOf(conductor, settings([monitors]))).toBe("monitors");
    expect(groupOf(other, settings([monitors]))).toBe(DEFAULT_SIDEBAR_GROUP_ID);
  });

  it("matches a repository rule on every machine, not by project id", () => {
    const repo: SidebarGroup = {
      id: "repo",
      name: "t3code",
      rules: [{ field: "project", operator: "is", values: ["github.com/yarden-zamir/t3code"] }],
    };
    expect(groupOf(thread(vps, "On the VPS", "project-vps"), settings([repo]))).toBe("repo");
  });

  it("skips a rule from a newer version instead of letting it claim every thread", () => {
    const future: SidebarGroup = {
      id: "future",
      name: "Future",
      rules: [{ field: "label", operator: "has", values: ["x"] }],
    };
    expect(groupOf(other, settings([future]))).toBe(DEFAULT_SIDEBAR_GROUP_ID);
  });

  it("shows every thread in an any-group view, which holds none itself", () => {
    const value = settings([monitors, all]);
    const shows = (subject: typeof conductor) =>
      sidebarGroupShowsThread({
        tabId: "all",
        thread: subject,
        threadGroupId: groupOf(subject, value),
        compiled: compileSidebarGroups(value),
        projects,
      });
    expect([shows(conductor), shows(other)]).toEqual([true, true]);
    expect(groupOf(other, value)).toBe(DEFAULT_SIDEBAR_GROUP_ID);
  });
});

describe("sidebar group assignments", () => {
  it("writes an entry only where the rules give another group", () => {
    const value = settings([monitors]);
    // Already in its group: no change.
    expect(moveSidebarThreads(value, [conductor], "monitors", projects)).toEqual(value);
    // No rule claims it: a drop on the default tab writes nothing.
    expect(moveSidebarThreads(value, [other], DEFAULT_SIDEBAR_GROUP_ID, projects)).toEqual(value);
    // A rule claims it: the default entry keeps it out.
    expect(
      moveSidebarThreads(value, [conductor], DEFAULT_SIDEBAR_GROUP_ID, projects).assignments,
    ).toEqual({ [sidebarGroupThreadKey(conductor)]: DEFAULT_SIDEBAR_GROUP_ID });
  });

  it("prunes entries of gone threads only, also when the rules agree with an entry", () => {
    const value = settings([monitors], {
      [sidebarGroupThreadKey(other)]: "monitors",
      "environment-mac:deleted-thread": "monitors",
      "environment-offline:thread": "monitors",
      [sidebarGroupThreadKey(conductor)]: "monitors",
    });
    // The rules put Conductor in Monitors now, but a title or status can change: the drag holds.
    expect(pruneSidebarGroupAssignments(value, [conductor, other]).assignments).toEqual({
      [sidebarGroupThreadKey(other)]: "monitors",
      "environment-offline:thread": "monitors",
      [sidebarGroupThreadKey(conductor)]: "monitors",
    });
  });
});
