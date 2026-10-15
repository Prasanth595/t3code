/**
 * Fork: sidebar thread groups. Each group is a tab above the sidebar list. A thread lives in one
 * group: the group that the user dragged it into, else the first group whose rules match it, else
 * the default tab. A group with a `group` rule is a view: it shows the threads of other groups and
 * holds none itself, so a user can build an "All" tab.
 */
import {
  isKnownSidebarGroupRule,
  repositoryGroupingDisplayNameOf,
  repositoryGroupingKeyOf,
  repositoryOwnerOf,
  SidebarGroupRuleField,
  type RepositoryIdentity,
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

/**
 * Project facts that rules compare, by `environmentId:projectId`. The repository key is the same
 * on every machine, unlike a project id, a path or the sidebar's project grouping, so a project
 * rule in the shared setting matches the same repository everywhere.
 */
export interface SidebarGroupProjectFacts {
  /** `repositoryGroupingKeyOf`, such as `github.com/yarden-zamir/t3code`. Null without a remote. */
  readonly repository: string | null;
  readonly repositoryLabel: string | null;
  readonly owner: string | null;
}

export type SidebarGroupProjectLookup = ReadonlyMap<string, SidebarGroupProjectFacts>;

export function buildSidebarGroupProjectFacts(
  projects: ReadonlyArray<{
    readonly environmentId: string;
    readonly id: string;
    readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
  }>,
): SidebarGroupProjectLookup {
  return new Map(
    projects.map((project) => {
      const identity = project.repositoryIdentity ?? null;
      return [
        `${project.environmentId}:${project.id}`,
        identity === null
          ? { repository: null, repositoryLabel: null, owner: null }
          : {
              repository: repositoryGroupingKeyOf(identity),
              repositoryLabel: repositoryGroupingDisplayNameOf(identity) ?? null,
              owner: repositoryOwnerOf(identity),
            },
      ] as const;
    }),
  );
}

export const sidebarGroupThreadKey = (thread: Pick<SidebarGroupThread, "environmentId" | "id">) =>
  `${thread.environmentId}:${thread.id}`;

const projectFactsOf = (thread: SidebarGroupThread, projects: SidebarGroupProjectLookup) =>
  projects.get(`${thread.environmentId}:${thread.projectId}`);

/** The rules this version knows. A rule from a newer version is skipped. */
const knownSidebarGroupRules = (group: Pick<SidebarGroup, "rules">) =>
  group.rules.filter(isKnownSidebarGroupRule);

const isSidebarGroupView = (group: Pick<SidebarGroup, "rules">) =>
  knownSidebarGroupRules(group).some((rule) => rule.field === "group");

interface CompiledSidebarGroup {
  readonly id: string;
  readonly rules: readonly SidebarGroupRule[];
  readonly isView: boolean;
  /** It has a known rule and is not a view, so its rules claim threads. */
  readonly takesThreadsByRules: boolean;
}

/**
 * The groups with their known rules and view flags, checked once per change of the groups. The
 * per-thread loops read this, so the rule guard does not run for every thread.
 */
interface CompiledSidebarGroups {
  readonly assignments: SidebarGroups["assignments"];
  /** In tab order, which is the order rules claim threads in. */
  readonly groups: readonly CompiledSidebarGroup[];
  readonly byId: ReadonlyMap<string, CompiledSidebarGroup>;
}

export function compileSidebarGroups(settings: SidebarGroups): CompiledSidebarGroups {
  const groups = settings.groups.map((group): CompiledSidebarGroup => {
    const rules = knownSidebarGroupRules(group);
    const isView = rules.some((rule) => rule.field === "group");
    return { id: group.id, rules, isView, takesThreadsByRules: rules.length > 0 && !isView };
  });
  return {
    assignments: settings.assignments,
    groups,
    byId: new Map(groups.map((group) => [group.id, group])),
  };
}

/** "Group is not (no group)": the rule of an "All" view. */
export const isAnyGroupRule = (rule: SidebarGroupRule) =>
  rule.field === "group" && rule.operator === "is_not" && rule.values.length === 0;

/** The values that a thread has for a field. Null stands for "none". */
function threadValues(
  field: Exclude<SidebarGroupRuleField, "title">,
  thread: SidebarGroupThread,
  projects: SidebarGroupProjectLookup,
  groupId: string,
): ReadonlyArray<string | null> {
  switch (field) {
    case "group":
      return [groupId];
    case "project":
      return [projectFactsOf(thread, projects)?.repository ?? null];
    case "owner":
      return [projectFactsOf(thread, projects)?.owner ?? null];
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

function ruleMatches(
  rule: SidebarGroupRule,
  thread: SidebarGroupThread,
  projects: SidebarGroupProjectLookup,
  groupId: string,
): boolean {
  const hit =
    rule.field === "title"
      ? rule.values.some(
          (value) => value !== null && thread.title.toLowerCase().includes(value.toLowerCase()),
        )
      : threadValues(rule.field, thread, projects, groupId).some((value) =>
          rule.values.includes(value),
        );
  return rule.operator === "is" ? hit : !hit;
}

const matchesEveryRule = (
  group: CompiledSidebarGroup,
  thread: SidebarGroupThread,
  projects: SidebarGroupProjectLookup,
  groupId: string,
) => group.rules.every((rule) => ruleMatches(rule, thread, projects, groupId));

/** The group that the rules alone give a thread: the first group whose rules match it. */
function resolveRuleGroupId(
  thread: SidebarGroupThread,
  compiled: CompiledSidebarGroups,
  projects: SidebarGroupProjectLookup,
): string {
  const group = compiled.groups.find(
    (candidate) =>
      candidate.takesThreadsByRules &&
      matchesEveryRule(candidate, thread, projects, DEFAULT_SIDEBAR_GROUP_ID),
  );
  return group?.id ?? DEFAULT_SIDEBAR_GROUP_ID;
}

/** Whether a drag assignment can hold a thread: the default tab, or a group that is not a view. */
const canHold = (compiled: CompiledSidebarGroups, groupId: string) =>
  groupId === DEFAULT_SIDEBAR_GROUP_ID || compiled.byId.get(groupId)?.isView === false;

/** The group that holds a thread. A drag assignment wins over the rules. */
export function resolveSidebarThreadGroupId(
  thread: SidebarGroupThread,
  compiled: CompiledSidebarGroups,
  projects: SidebarGroupProjectLookup,
): string {
  const assigned = compiled.assignments[sidebarGroupThreadKey(thread)];
  return assigned !== undefined && canHold(compiled, assigned)
    ? assigned
    : resolveRuleGroupId(thread, compiled, projects);
}

/** Whether a tab shows a thread, given the group that holds the thread. */
export function sidebarGroupShowsThread(input: {
  readonly tabId: string;
  readonly thread: SidebarGroupThread;
  readonly threadGroupId: string;
  readonly compiled: CompiledSidebarGroups;
  readonly projects: SidebarGroupProjectLookup;
}): boolean {
  if (input.tabId === DEFAULT_SIDEBAR_GROUP_ID) {
    return input.threadGroupId === DEFAULT_SIDEBAR_GROUP_ID;
  }
  const group = input.compiled.byId.get(input.tabId);
  if (group === undefined) return false;
  if (!group.isView) return input.threadGroupId === group.id;
  return matchesEveryRule(group, input.thread, input.projects, input.threadGroupId);
}

/**
 * Moves threads into a group by drag. A thread that the group already holds does not change. An
 * assignment is written only where the rules give another group, so a drop on the default tab
 * writes nothing for a thread that no rule claims.
 */
export function moveSidebarThreads(
  settings: SidebarGroups,
  threads: ReadonlyArray<SidebarGroupThread>,
  groupId: string,
  projects: SidebarGroupProjectLookup,
): SidebarGroups {
  const compiled = compileSidebarGroups(settings);
  if (!canHold(compiled, groupId)) return settings;
  const assignments = { ...settings.assignments };
  for (const thread of threads) {
    if (resolveSidebarThreadGroupId(thread, compiled, projects) === groupId) continue;
    const key = sidebarGroupThreadKey(thread);
    if (resolveRuleGroupId(thread, compiled, projects) === groupId) delete assignments[key];
    else assignments[key] = groupId;
  }
  return { ...settings, assignments };
}

/**
 * Drops assignments that can do nothing any more: a thread that is gone or archived on an
 * environment whose threads are loaded, or a group that cannot hold threads. An entry that the
 * rules agree with stays: rules on status, background work or title change over time, and the
 * drag must still hold when they stop matching. An offline environment keeps its entries,
 * because its threads are not known.
 */
export function pruneSidebarGroupAssignments(
  settings: SidebarGroups,
  liveThreads: ReadonlyArray<SidebarGroupThread>,
): SidebarGroups {
  const compiled = compileSidebarGroups(settings);
  const liveKeys = new Set(liveThreads.map(sidebarGroupThreadKey));
  const loadedEnvironments = new Set<string>(liveThreads.map((thread) => thread.environmentId));
  const assignments = Object.fromEntries(
    Object.entries(settings.assignments).filter(
      ([key, groupId]) =>
        canHold(compiled, groupId) &&
        (liveKeys.has(key) || !loadedEnvironments.has(key.slice(0, key.indexOf(":")))),
    ),
  );
  return { ...settings, assignments };
}

/** A new group named "Group N" with the lowest free N. */
export function createSidebarGroup(settings: SidebarGroups, id: string): SidebarGroups {
  const names = new Set(settings.groups.map((group) => group.name));
  let index = settings.groups.length + 1;
  while (names.has(`Group ${index}`)) index += 1;
  return { ...settings, groups: [...settings.groups, { id, name: `Group ${index}`, rules: [] }] };
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

/**
 * Checks or unchecks one value of a field in the rule editor. A field has one rule. Checking a
 * group in an "any group" view turns it into "group is X". Unchecking the last value removes the
 * rule, so no rule is left with no values: "is not (nothing)" would match every thread.
 */
export function toggleSidebarGroupRuleValue(
  rules: SidebarGroup["rules"],
  field: SidebarGroupRuleField,
  value: string | null,
  checked: boolean,
): SidebarGroup["rules"] {
  const index = rules.findIndex((rule) => isKnownSidebarGroupRule(rule) && rule.field === field);
  const current = index === -1 ? null : rules[index]!;
  if (current === null || !isKnownSidebarGroupRule(current)) {
    return checked ? [...rules, { field, operator: "is", values: [value] }] : rules;
  }
  const next: SidebarGroupRule = checked
    ? isAnyGroupRule(current)
      ? { field, operator: "is", values: [value] }
      : { ...current, values: [...current.values, value] }
    : { ...current, values: current.values.filter((candidate) => candidate !== value) };
  return next.values.length === 0
    ? rules.filter((_, candidate) => candidate !== index)
    : rules.map((rule, candidate) => (candidate === index ? next : rule));
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

/** The most urgent status of a tab, or null when every thread rests. */
export function resolveSidebarGroupTabStatus(
  states: ReadonlyArray<{
    readonly thread: SidebarGroupThread;
    readonly isUnread: boolean;
    readonly isWoke: boolean;
  }>,
): SidebarV2TopStatusKind | null {
  let best: SidebarV2TopStatusKind | null = null;
  for (const state of states) {
    const kind = resolveSidebarV2TopStatus({
      status: resolveSidebarThreadStatus(state.thread),
      isUnread: state.isUnread,
      isWoke: state.isWoke,
    });
    if (kind === null) continue;
    if (best === null || TAB_STATUS_PRIORITY.indexOf(kind) < TAB_STATUS_PRIORITY.indexOf(best)) {
      best = kind;
    }
  }
  return best;
}

const RULE_FIELD_LABELS: Record<SidebarGroupRuleField, string> = {
  group: "Group",
  project: "Repository",
  owner: "Owner",
  status: "Status",
  provider: "Provider",
  createdBy: "Created by",
  background: "Background work",
  title: "Title",
};

/** Rule fields in menu order. */
export const SIDEBAR_GROUP_RULE_FIELDS = SidebarGroupRuleField.literals;

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
 * The values a rule of a field can pick. Repositories, owners and providers come from the
 * threads, so the menu lists only values that some thread has. A group rule lists the other
 * groups that hold threads.
 */
export function buildSidebarGroupRuleOptions(input: {
  readonly field: Exclude<SidebarGroupRuleField, "title">;
  readonly groupId: string;
  readonly threads: ReadonlyArray<SidebarGroupThread>;
  readonly projects: SidebarGroupProjectLookup;
  readonly settings: SidebarGroups;
}): SidebarGroupRuleOption[] {
  const distinct = (values: ReadonlyArray<readonly [string | null, string]>, none: string) =>
    [...new Map(values)]
      .map(([value, label]) => ({ value, label: value === null ? none : label }))
      .toSorted((left, right) =>
        left.value === null ? 1 : right.value === null ? -1 : left.label.localeCompare(right.label),
      );
  const facts = (thread: SidebarGroupThread) => projectFactsOf(thread, input.projects);
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
        input.threads.map((thread) => {
          const repository = facts(thread)?.repository ?? null;
          return [repository, facts(thread)?.repositoryLabel ?? repository ?? ""] as const;
        }),
        "No repository",
      );
    case "owner":
      return distinct(
        input.threads.map((thread) => {
          const owner = facts(thread)?.owner ?? null;
          return [owner, owner ?? ""] as const;
        }),
        "No owner",
      );
    case "status":
      return Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }));
    case "provider":
      return distinct(
        input.threads.map((thread) => [thread.providerInstanceId, thread.providerInstanceId]),
        "None",
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
