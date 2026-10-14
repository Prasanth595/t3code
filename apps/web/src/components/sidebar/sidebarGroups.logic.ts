/**
 * Fork: sidebar thread groups. Each group is a tab above the sidebar list. A thread lives in one
 * group: the group that the user dragged it into, else the first group whose rules match it, else
 * the default tab. A group with a `group` rule is a view: it shows the threads of other groups and
 * holds none itself, so a user can build an "All" tab.
 */
import {
  SidebarGroupRuleField,
  type SidebarGroup,
  type SidebarGroupRule,
  type SidebarGroups,
} from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../../types";
import {
  resolveSidebarThreadStatus,
  resolveSidebarV2TopStatus,
  type SidebarThreadStatus,
  type SidebarV2TopStatusKind,
} from "../Sidebar.logic";

export const DEFAULT_SIDEBAR_GROUP_ID = "default";
export const DEFAULT_SIDEBAR_GROUP_NAME = "Threads";

export type SidebarGroupThread = Pick<
  SidebarThreadSummary,
  | "environmentId"
  | "id"
  | "projectId"
  | "title"
  | "providerInstanceId"
  | "pendingBackgroundTasks"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "runtime"
> & { readonly source: Pick<SidebarThreadSummary["source"], "createdBy"> };

/** Project facts that rules compare, by `environmentId:projectId`. */
export interface SidebarGroupProjectFacts {
  /** The logical project, so one rule covers the same repository on every environment. */
  readonly projectKey: string;
  readonly owner: string | null;
}

export type SidebarGroupProjectLookup = ReadonlyMap<string, SidebarGroupProjectFacts>;

export const sidebarGroupThreadKey = (thread: Pick<SidebarGroupThread, "environmentId" | "id">) =>
  `${thread.environmentId}:${thread.id}`;

const projectRefKey = (thread: Pick<SidebarGroupThread, "environmentId" | "projectId">) =>
  `${thread.environmentId}:${thread.projectId}`;

export const isSidebarGroupView = (group: Pick<SidebarGroup, "rules">) =>
  group.rules.some((rule) => rule.field === "group");

/** The values that a thread has for a field. Null stands for "none". */
export function sidebarGroupThreadValues(input: {
  readonly field: Exclude<SidebarGroupRuleField, "title">;
  readonly thread: SidebarGroupThread;
  readonly projects: SidebarGroupProjectLookup;
  readonly groupId: string;
}): ReadonlyArray<string | null> {
  const { thread } = input;
  switch (input.field) {
    case "group":
      return [input.groupId];
    case "project":
      return [input.projects.get(projectRefKey(thread))?.projectKey ?? projectRefKey(thread)];
    case "owner":
      return [input.projects.get(projectRefKey(thread))?.owner ?? null];
    case "status":
      return [resolveSidebarThreadStatus(thread)];
    case "provider":
      return [thread.providerInstanceId];
    case "createdBy":
      return [thread.source.createdBy];
    case "background": {
      const kinds = [...new Set((thread.pendingBackgroundTasks ?? []).map((task) => task.kind))];
      return kinds.length === 0 ? [null] : kinds;
    }
  }
}

export function sidebarGroupRuleMatches(input: {
  readonly rule: SidebarGroupRule;
  readonly thread: SidebarGroupThread;
  readonly projects: SidebarGroupProjectLookup;
  readonly groupId: string;
}): boolean {
  const { rule } = input;
  let hit: boolean;
  if (rule.field === "title") {
    const title = input.thread.title.toLowerCase();
    hit = rule.values.some((value) => value !== null && title.includes(value.toLowerCase()));
  } else {
    const values = sidebarGroupThreadValues({ ...input, field: rule.field });
    hit = values.some((value) => rule.values.includes(value));
  }
  return rule.operator === "is" ? hit : !hit;
}

/**
 * The group that holds a thread. A drag assignment wins over rules. A group with no rules holds
 * only the threads dragged into it, and a view holds none.
 */
export function resolveSidebarThreadGroupId(input: {
  readonly thread: SidebarGroupThread;
  readonly settings: SidebarGroups;
  readonly projects: SidebarGroupProjectLookup;
}): string {
  const { settings } = input;
  const assigned = settings.assignments[sidebarGroupThreadKey(input.thread)];
  if (assigned === DEFAULT_SIDEBAR_GROUP_ID) return assigned;
  if (assigned !== undefined) {
    const group = settings.groups.find((candidate) => candidate.id === assigned);
    if (group !== undefined && !isSidebarGroupView(group)) return group.id;
  }
  for (const group of settings.groups) {
    if (group.rules.length === 0 || isSidebarGroupView(group)) continue;
    if (
      group.rules.every((rule) =>
        sidebarGroupRuleMatches({
          rule,
          thread: input.thread,
          projects: input.projects,
          groupId: DEFAULT_SIDEBAR_GROUP_ID,
        }),
      )
    ) {
      return group.id;
    }
  }
  return DEFAULT_SIDEBAR_GROUP_ID;
}

/** Whether a tab shows a thread, given the group that holds the thread. */
export function sidebarGroupShowsThread(input: {
  readonly tabId: string;
  readonly thread: SidebarGroupThread;
  readonly threadGroupId: string;
  readonly settings: SidebarGroups;
  readonly projects: SidebarGroupProjectLookup;
}): boolean {
  if (input.tabId === DEFAULT_SIDEBAR_GROUP_ID) {
    return input.threadGroupId === DEFAULT_SIDEBAR_GROUP_ID;
  }
  const group = input.settings.groups.find((candidate) => candidate.id === input.tabId);
  if (group === undefined) return false;
  if (!isSidebarGroupView(group)) return input.threadGroupId === group.id;
  return group.rules.every((rule) =>
    sidebarGroupRuleMatches({
      rule,
      thread: input.thread,
      projects: input.projects,
      groupId: input.threadGroupId,
    }),
  );
}

/** The tab ids, default first, then the groups in tab order. */
export function sidebarGroupTabIds(settings: SidebarGroups): string[] {
  return [DEFAULT_SIDEBAR_GROUP_ID, ...settings.groups.map((group) => group.id)];
}

/** The tab that shows a thread: its own group, else the first view that shows it. */
export function resolveSidebarThreadTabId(input: {
  readonly thread: SidebarGroupThread;
  readonly threadGroupId: string;
  readonly settings: SidebarGroups;
  readonly projects: SidebarGroupProjectLookup;
  readonly currentTabId: string;
}): string {
  if (sidebarGroupShowsThread({ ...input, tabId: input.currentTabId })) return input.currentTabId;
  return input.threadGroupId;
}

// Highest first. A tab shows the status of its most urgent thread.
const TAB_STATUS_PRIORITY: readonly SidebarV2TopStatusKind[] = [
  "approval",
  "input",
  "failed",
  "limited",
  "woke",
  "done",
  "working",
  "waiting",
];

/** The statuses that make a tab play its attention animation. */
export const SIDEBAR_GROUP_ATTENTION_STATUSES: ReadonlySet<SidebarV2TopStatusKind> = new Set([
  "approval",
  "input",
  "failed",
  "limited",
]);

export interface SidebarGroupTabThreadState {
  readonly thread: SidebarGroupThread;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
}

/** The thread with the most urgent status of a tab, or null when every thread rests. */
export function resolveSidebarGroupTabStatus<State extends SidebarGroupTabThreadState>(
  states: ReadonlyArray<State>,
): { readonly kind: SidebarV2TopStatusKind; readonly state: State } | null {
  let best: { kind: SidebarV2TopStatusKind; state: State } | null = null;
  for (const state of states) {
    const kind = resolveSidebarV2TopStatus({
      status: resolveSidebarThreadStatus(state.thread),
      isUnread: state.isUnread,
      isWoke: state.isWoke,
    });
    if (kind === null) continue;
    if (
      best === null ||
      TAB_STATUS_PRIORITY.indexOf(kind) < TAB_STATUS_PRIORITY.indexOf(best.kind)
    ) {
      best = { kind, state };
    }
  }
  return best;
}

/** Puts threads into a group by drag. The default id takes them out of every group. */
export function assignSidebarThreadsToGroup(
  settings: SidebarGroups,
  threadKeys: readonly string[],
  groupId: string,
): SidebarGroups {
  const assignments = { ...settings.assignments };
  for (const key of threadKeys) assignments[key] = groupId;
  return { ...settings, assignments };
}

/** A new group named "Group N" with the lowest free N, holding the given threads. */
export function createSidebarGroup(
  settings: SidebarGroups,
  input: { readonly id: string; readonly threadKeys: readonly string[] },
): SidebarGroups {
  const names = new Set(settings.groups.map((group) => group.name));
  let index = settings.groups.length + 1;
  while (names.has(`Group ${index}`)) index += 1;
  const group: SidebarGroup = { id: input.id, name: `Group ${index}`, rules: [] };
  return assignSidebarThreadsToGroup(
    { ...settings, groups: [...settings.groups, group] },
    input.threadKeys,
    input.id,
  );
}

/** Deletes a group. Its dragged threads go back to the rules, and views stop naming it. */
export function deleteSidebarGroup(settings: SidebarGroups, groupId: string): SidebarGroups {
  const assignments = Object.fromEntries(
    Object.entries(settings.assignments).filter(([, assigned]) => assigned !== groupId),
  );
  const groups = settings.groups
    .filter((group) => group.id !== groupId)
    .map((group) => ({
      ...group,
      // The rule stays, also with no values, so a view does not turn into a group that holds threads.
      rules: group.rules.map((rule) =>
        rule.field === "group"
          ? { ...rule, values: rule.values.filter((value) => value !== groupId) }
          : rule,
      ),
    }));
  return { groups, assignments };
}

export function updateSidebarGroup(
  settings: SidebarGroups,
  groupId: string,
  update: (group: SidebarGroup) => SidebarGroup,
): SidebarGroups {
  return {
    ...settings,
    groups: settings.groups.map((group) => (group.id === groupId ? update(group) : group)),
  };
}

/** Moves a group to a new tab position, counted among the groups (the default tab is fixed). */
export function moveSidebarGroup(
  settings: SidebarGroups,
  groupId: string,
  toIndex: number,
): SidebarGroups {
  const group = settings.groups.find((candidate) => candidate.id === groupId);
  if (group === undefined) return settings;
  const rest = settings.groups.filter((candidate) => candidate.id !== groupId);
  const index = Math.max(0, Math.min(toIndex, rest.length));
  return { ...settings, groups: [...rest.slice(0, index), group, ...rest.slice(index)] };
}

/** Rule fields in menu order. */
export const SIDEBAR_GROUP_RULE_FIELDS = SidebarGroupRuleField.literals;

const RULE_FIELD_LABELS: Record<SidebarGroupRuleField, string> = {
  group: "Group",
  project: "Project",
  owner: "Owner",
  status: "Status",
  provider: "Provider",
  createdBy: "Created by",
  background: "Background work",
  title: "Title",
};

export const sidebarGroupRuleFieldLabel = (field: SidebarGroupRuleField) =>
  RULE_FIELD_LABELS[field];

const STATUS_LABELS: Record<SidebarThreadStatus, string> = {
  approval: "Approval",
  input: "Input",
  working: "Working",
  waiting: "Waiting",
  failed: "Failed",
  limited: "Limited",
  ready: "Ready",
};

const CREATED_BY_LABELS: Record<SidebarGroupThread["source"]["createdBy"], string> = {
  user: "You",
  agent: "An agent",
  system: "T3 Code",
};

type BackgroundKind = NonNullable<SidebarGroupThread["pendingBackgroundTasks"]>[number]["kind"];
const BACKGROUND_LABELS: Record<BackgroundKind, string> = {
  monitor: "Monitor or pull request watch",
  subagent: "Subagent",
  command: "Command",
  background_task: "Background task",
};

export interface SidebarGroupRuleOption {
  readonly value: string | null;
  readonly label: string;
}

/**
 * The values a rule of a field can pick. Projects, owners and providers come from the threads,
 * so the menu lists only values that some thread has. A group rule lists the other groups.
 */
export function buildSidebarGroupRuleOptions(input: {
  readonly field: Exclude<SidebarGroupRuleField, "title">;
  readonly groupId: string;
  readonly threads: ReadonlyArray<SidebarGroupThread>;
  readonly projects: SidebarGroupProjectLookup;
  readonly projectLabels: ReadonlyMap<string, string>;
  readonly settings: SidebarGroups;
}): SidebarGroupRuleOption[] {
  const distinct = (values: ReadonlyArray<string | null>, label: (value: string) => string) =>
    [...new Set(values)]
      .map((value) => ({ value, label: value === null ? "None" : label(value) }))
      .toSorted((left, right) =>
        left.value === null ? 1 : right.value === null ? -1 : left.label.localeCompare(right.label),
      );
  switch (input.field) {
    case "group":
      return [
        { value: DEFAULT_SIDEBAR_GROUP_ID, label: DEFAULT_SIDEBAR_GROUP_NAME },
        ...input.settings.groups
          .filter((group) => group.id !== input.groupId && !isSidebarGroupView(group))
          .map((group) => ({ value: group.id, label: group.name })),
      ];
    case "project":
      return distinct(
        input.threads.map(
          (thread) =>
            input.projects.get(projectRefKey(thread))?.projectKey ?? projectRefKey(thread),
        ),
        (value) => input.projectLabels.get(value) ?? value,
      );
    case "owner":
      return distinct(
        input.threads.map((thread) => input.projects.get(projectRefKey(thread))?.owner ?? null),
        (value) => value,
      );
    case "status":
      return Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }));
    case "provider":
      return distinct(
        input.threads.map((thread) => thread.providerInstanceId),
        (value) => value,
      );
    case "createdBy":
      return Object.entries(CREATED_BY_LABELS).map(([value, label]) => ({ value, label }));
    case "background":
      return [
        ...Object.entries(BACKGROUND_LABELS).map(([value, label]) => ({ value, label })),
        { value: null, label: "None" },
      ];
  }
}
