import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type SidebarGroup,
  type SidebarGroups,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../../test-fixtures";
import {
  buildSidebarGroupRuleOptions,
  createSidebarGroup,
  DEFAULT_SIDEBAR_GROUP_ID,
  deleteSidebarGroup,
  moveSidebarGroup,
  resolveSidebarGroupTabStatus,
  resolveSidebarThreadGroupId,
  sidebarGroupShowsThread,
  sidebarGroupThreadKey,
  type SidebarGroupProjectLookup,
  type SidebarGroupThread,
} from "./sidebarGroups.logic";

const mac = EnvironmentId.make("environment-mac");

function thread(id: string, overrides: ThreadFixtureOverrides = {}): SidebarGroupThread {
  return makeThreadFixture({
    environmentId: mac,
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-t3code"),
    title: id,
    ...overrides,
  });
}

const projects: SidebarGroupProjectLookup = new Map([
  [
    `${mac}:project-t3code`,
    { projectKey: "github.com/yarden-zamir/t3code", owner: "yarden-zamir" },
  ],
  [
    `${mac}:project-tick3d`,
    { projectKey: "github.com/yarden-zamir/tick3d", owner: "yarden-zamir" },
  ],
  [`${mac}:project-scratch`, { projectKey: "scratch", owner: null }],
]);

const monitors: SidebarGroup = {
  id: "monitors",
  name: "Monitors",
  rules: [{ field: "title", operator: "is", values: ["conductor"] }],
};
const manual: SidebarGroup = { id: "manual", name: "Later", rules: [] };
const all: SidebarGroup = {
  id: "all",
  name: "All",
  rules: [{ field: "group", operator: "is_not", values: [] }],
};

function settings(groups: SidebarGroup[], assignments: Record<string, string> = {}): SidebarGroups {
  return { groups, assignments };
}

function groupOf(subject: SidebarGroupThread, groupSettings: SidebarGroups) {
  return resolveSidebarThreadGroupId({ thread: subject, settings: groupSettings, projects });
}

function shows(tabId: string, subject: SidebarGroupThread, groupSettings: SidebarGroups) {
  return sidebarGroupShowsThread({
    tabId,
    thread: subject,
    threadGroupId: groupOf(subject, groupSettings),
    settings: groupSettings,
    projects,
  });
}

describe("resolveSidebarThreadGroupId", () => {
  const conductor = thread("Conductor");
  const other = thread("Fix overlay");

  it("puts a thread in the first group whose rules match, else in the default tab", () => {
    const groupSettings = settings([monitors, manual]);
    expect(groupOf(conductor, groupSettings)).toBe("monitors");
    expect(groupOf(other, groupSettings)).toBe(DEFAULT_SIDEBAR_GROUP_ID);
  });

  it("lets a drag assignment win over the rules, also an assignment to the default tab", () => {
    expect(
      groupOf(other, settings([monitors, manual], { [sidebarGroupThreadKey(other)]: "manual" })),
    ).toBe("manual");
    expect(
      groupOf(
        conductor,
        settings([monitors], { [sidebarGroupThreadKey(conductor)]: DEFAULT_SIDEBAR_GROUP_ID }),
      ),
    ).toBe(DEFAULT_SIDEBAR_GROUP_ID);
  });

  it("ignores an assignment to a deleted group or to a view", () => {
    expect(groupOf(other, settings([], { [sidebarGroupThreadKey(other)]: "gone" }))).toBe(
      DEFAULT_SIDEBAR_GROUP_ID,
    );
    expect(groupOf(other, settings([all], { [sidebarGroupThreadKey(other)]: "all" }))).toBe(
      DEFAULT_SIDEBAR_GROUP_ID,
    );
  });

  it("does not let a group without rules or a view take threads by rules", () => {
    expect(groupOf(other, settings([manual, all]))).toBe(DEFAULT_SIDEBAR_GROUP_ID);
  });

  it("matches project, owner, provider, status and background rules", () => {
    const tick = thread("Ship it", {
      projectId: ProjectId.make("project-tick3d"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      hasPendingApprovals: true,
    });
    const rule = (group: SidebarGroup["rules"][number]) =>
      groupOf(tick, settings([{ id: "g", name: "G", rules: [group] }]));
    expect(
      rule({ field: "project", operator: "is", values: ["github.com/yarden-zamir/tick3d"] }),
    ).toBe("g");
    expect(rule({ field: "owner", operator: "is_not", values: ["yarden-zamir"] })).toBe(
      DEFAULT_SIDEBAR_GROUP_ID,
    );
    expect(rule({ field: "provider", operator: "is", values: ["claudeAgent"] })).toBe("g");
    expect(rule({ field: "status", operator: "is", values: ["approval"] })).toBe("g");
    // No background work reads as "none" (null).
    expect(rule({ field: "background", operator: "is", values: [null] })).toBe("g");
  });

  it("matches a project without an owner with a null owner value", () => {
    const scratch = thread("Scratch", { projectId: ProjectId.make("project-scratch") });
    expect(
      groupOf(
        scratch,
        settings([
          { id: "g", name: "G", rules: [{ field: "owner", operator: "is", values: [null] }] },
        ]),
      ),
    ).toBe("g");
  });
});

describe("sidebarGroupShowsThread", () => {
  const conductor = thread("Conductor");
  const other = thread("Fix overlay");
  const groupSettings = settings([monitors, all]);

  it("shows each thread in exactly one holding tab", () => {
    expect(shows("monitors", conductor, groupSettings)).toBe(true);
    expect(shows(DEFAULT_SIDEBAR_GROUP_ID, conductor, groupSettings)).toBe(false);
    expect(shows(DEFAULT_SIDEBAR_GROUP_ID, other, groupSettings)).toBe(true);
    expect(shows("monitors", other, groupSettings)).toBe(false);
  });

  it("shows every thread in an any-group view", () => {
    expect(shows("all", conductor, groupSettings)).toBe(true);
    expect(shows("all", other, groupSettings)).toBe(true);
  });

  it("shows the threads of the named groups in a group view", () => {
    const view: SidebarGroup = {
      id: "view",
      name: "Default only",
      rules: [{ field: "group", operator: "is", values: [DEFAULT_SIDEBAR_GROUP_ID] }],
    };
    const withView = settings([monitors, view]);
    expect(shows("view", other, withView)).toBe(true);
    expect(shows("view", conductor, withView)).toBe(false);
  });

  it("shows nothing for an unknown tab", () => {
    expect(shows("gone", other, groupSettings)).toBe(false);
  });
});

describe("group edits", () => {
  it("creates numbered groups that hold the dragged threads", () => {
    const first = createSidebarGroup(settings([]), { id: "a", threadKeys: ["k1"] });
    const second = createSidebarGroup(first, { id: "b", threadKeys: [] });
    expect(second.groups.map((group) => group.name)).toEqual(["Group 1", "Group 2"]);
    expect(second.assignments).toEqual({ k1: "a" });
  });

  it("deletes a group with its assignments and keeps views that named it as views", () => {
    const view: SidebarGroup = {
      id: "view",
      name: "View",
      rules: [{ field: "group", operator: "is", values: ["monitors"] }],
    };
    const next = deleteSidebarGroup(
      settings([monitors, view], { k1: "monitors", k2: DEFAULT_SIDEBAR_GROUP_ID }),
      "monitors",
    );
    expect(next.groups.map((group) => group.id)).toEqual(["view"]);
    expect(next.groups[0]!.rules).toEqual([{ field: "group", operator: "is", values: [] }]);
    expect(next.assignments).toEqual({ k2: DEFAULT_SIDEBAR_GROUP_ID });
  });

  it("moves a group to a new position and clamps the index", () => {
    const moved = moveSidebarGroup(settings([monitors, manual, all]), "all", 0);
    expect(moved.groups.map((group) => group.id)).toEqual(["all", "monitors", "manual"]);
    expect(moveSidebarGroup(moved, "all", 99).groups.at(-1)!.id).toBe("all");
  });
});

describe("resolveSidebarGroupTabStatus", () => {
  it("picks the most urgent thread and ignores resting threads", () => {
    const states = [
      { thread: thread("a"), isUnread: true, isWoke: false },
      { thread: thread("b", { hasPendingUserInput: true }), isUnread: false, isWoke: false },
      { thread: thread("c"), isUnread: false, isWoke: false },
    ];
    expect(resolveSidebarGroupTabStatus(states)?.kind).toBe("input");
    expect(resolveSidebarGroupTabStatus([states[2]!])).toBeNull();
    expect(resolveSidebarGroupTabStatus([states[0]!, states[2]!])?.kind).toBe("done");
  });
});

describe("buildSidebarGroupRuleOptions", () => {
  it("offers the default tab and the other holding groups for a group rule", () => {
    const options = buildSidebarGroupRuleOptions({
      field: "group",
      groupId: "all",
      threads: [],
      projects,
      projectLabels: new Map(),
      settings: settings([monitors, all]),
    });
    expect(options.map((option) => option.value)).toEqual([DEFAULT_SIDEBAR_GROUP_ID, "monitors"]);
  });

  it("offers the owners that threads have, with no owner last", () => {
    const options = buildSidebarGroupRuleOptions({
      field: "owner",
      groupId: "g",
      threads: [thread("a", { projectId: ProjectId.make("project-scratch") }), thread("b")],
      projects,
      projectLabels: new Map(),
      settings: settings([]),
    });
    expect(options.map((option) => option.value)).toEqual(["yarden-zamir", null]);
  });
});
