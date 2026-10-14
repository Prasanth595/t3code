/**
 * Fork: the state of the sidebar thread groups, kept out of `Sidebar.tsx` so that the upstream
 * file changes little.
 */
import {
  repositoryOwnerOf,
  type SidebarGroup,
  type SidebarGroupRule,
  type SidebarGroupRuleField,
  type SidebarGroups,
} from "@t3tools/contracts";
import { effectiveSnoozed, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { randomUUID } from "~/lib/utils";
import {
  useClientSettings,
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  type SidebarV2TopStatusKind,
} from "../Sidebar.logic";
import { useSidebarGroupTabStore } from "./sidebarGroupTabStore";
import {
  assignSidebarThreadsToGroup,
  buildSidebarGroupRuleOptions,
  createSidebarGroup,
  DEFAULT_SIDEBAR_GROUP_ID,
  DEFAULT_SIDEBAR_GROUP_NAME,
  deleteSidebarGroup,
  isSidebarGroupView,
  moveSidebarGroup,
  resolveSidebarGroupTabStatus,
  resolveSidebarThreadGroupId,
  SIDEBAR_GROUP_ATTENTION_STATUSES,
  sidebarGroupShowsThread,
  sidebarGroupThreadKey,
  type SidebarGroupProjectFacts,
  updateSidebarGroup,
} from "./sidebarGroups.logic";
import { resolveThreadCardStatus, type ThreadCardStatus } from "./threadCardParts";

export interface SidebarGroupTab {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly isView: boolean;
  /** Threads that the tab shows, without the settled ones. */
  readonly threadCount: number;
  /** The status of the most urgent thread, with the same label, icon and color as its row. */
  readonly status: {
    readonly kind: SidebarV2TopStatusKind;
    readonly card: ThreadCardStatus;
  } | null;
  readonly needsAttention: boolean;
  /** The one thread of the tab, when a click on the tab opens it. */
  readonly singleThread: SidebarThreadSummary | null;
}

const EMPTY_SETTINGS: SidebarGroups = { groups: [], assignments: {} };

export function useSidebarGroups(input: {
  /** Threads after the owner filter and the project scope. */
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly projectGroups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly routeThreadKey: string | null;
  /** Search covers every tab. */
  readonly searching: boolean;
}) {
  const { threads, projectGroups, routeThreadKey, searching } = input;
  // The groups live in the shared server settings, so every device and machine sees the same
  // groups. The hosted app has no primary server to hold them, so it shows none.
  const enabled = useClientSettings((s) => s.sidebarGroupsEnabled) && usePrimarySettingsAvailable();
  const savedSettings = usePrimarySettings((s) => s.sidebarGroups);
  const singleThreadOpens = useClientSettings((s) => s.sidebarGroupSingleThreadOpens);
  const settings = enabled ? savedSettings : EMPTY_SETTINGS;
  const updatePrimarySettings = useUpdatePrimarySettings();
  const storedTabId = useSidebarGroupTabStore((s) => s.tabId);
  const setTabId = useSidebarGroupTabStore((s) => s.setTabId);
  const tabId =
    enabled && settings.groups.some((group) => group.id === storedTabId)
      ? storedTabId
      : DEFAULT_SIDEBAR_GROUP_ID;

  const projects = useMemo(() => {
    const facts = new Map<string, SidebarGroupProjectFacts>();
    for (const group of projectGroups) {
      const owner = group.repositoryIdentity ? repositoryOwnerOf(group.repositoryIdentity) : null;
      for (const ref of group.memberProjectRefs) {
        facts.set(`${ref.environmentId}:${ref.projectId}`, {
          projectKey: group.projectKey,
          owner,
        });
      }
    }
    return facts;
  }, [projectGroups]);

  const projectLabels = useMemo(
    () => new Map(projectGroups.map((group) => [group.projectKey, group.displayName] as const)),
    [projectGroups],
  );
  const ruleOptions = useCallback(
    (field: Exclude<SidebarGroupRuleField, "title">, groupId: string) =>
      buildSidebarGroupRuleOptions({ field, groupId, threads, projects, projectLabels, settings }),
    [projectLabels, projects, settings, threads],
  );

  const groupIdByThreadKey = useMemo(
    () =>
      new Map(
        threads.map((thread) => [
          sidebarGroupThreadKey(thread),
          resolveSidebarThreadGroupId({ thread, settings, projects }),
        ]),
      ),
    [projects, settings, threads],
  );

  const showsThread = useCallback(
    (tab: string, thread: SidebarThreadSummary) =>
      sidebarGroupShowsThread({
        tabId: tab,
        thread,
        threadGroupId:
          groupIdByThreadKey.get(sidebarGroupThreadKey(thread)) ?? DEFAULT_SIDEBAR_GROUP_ID,
        settings,
        projects,
      }),
    [groupIdByThreadKey, projects, settings],
  );

  /** The threads of the open tab. Search and a disabled feature see every thread. */
  const visibleThreads = useMemo(
    () =>
      !enabled || searching ? threads : threads.filter((thread) => showsThread(tabId, thread)),
    [enabled, searching, showsThread, tabId, threads],
  );

  // Unread and woke are row-local elsewhere; the tabs need them for every thread.
  const localLastVisitedAt = useUiStateStore(
    useShallow((state) =>
      enabled
        ? threads.map((thread) => state.threadLastVisitedAtById[sidebarGroupThreadKey(thread)])
        : [],
    ),
  );

  const tabs = useMemo((): SidebarGroupTab[] => {
    if (!enabled) return [];
    const now = new Date().toISOString();
    const states = threads.map((thread, index) => {
      const lastVisitedAt = resolveThreadLastVisitedAt(
        thread.lastVisitedAt,
        localLastVisitedAt[index],
      );
      const wokeAt = threadWokeAt(thread, { now });
      const settled = thread.settledOverride === "settled";
      const isWoke =
        wokeAt !== null &&
        !settled &&
        (lastVisitedAt === undefined || Date.parse(lastVisitedAt) < Date.parse(wokeAt));
      return {
        thread,
        settled,
        asleep: settled || effectiveSnoozed(thread, { now }),
        isUnread: hasUnseenCompletion({ ...thread, lastVisitedAt }),
        isWoke,
      };
    });
    const describe = (id: string, name: string, group: SidebarGroup | null): SidebarGroupTab => {
      const shown = states.filter((state) => showsThread(id, state.thread));
      const open = shown.filter((state) => !state.settled);
      const best = resolveSidebarGroupTabStatus(shown.filter((state) => !state.asleep));
      const card =
        best === null
          ? null
          : resolveThreadCardStatus({
              status: resolveSidebarThreadStatus(best.state.thread),
              isWoke: best.state.isWoke,
              isUnread: best.state.isUnread,
              goalActive: best.state.thread.goal?.status === "active",
            });
      return {
        id,
        name,
        isDefault: group === null,
        isView: group !== null && isSidebarGroupView(group),
        threadCount: open.length,
        status: best === null || card === null ? null : { kind: best.kind, card },
        needsAttention: best !== null && SIDEBAR_GROUP_ATTENTION_STATUSES.has(best.kind),
        singleThread:
          singleThreadOpens && group !== null && open.length === 1 ? open[0]!.thread : null,
      };
    };
    return [
      describe(DEFAULT_SIDEBAR_GROUP_ID, DEFAULT_SIDEBAR_GROUP_NAME, null),
      ...settings.groups.map((group) => describe(group.id, group.name, group)),
    ];
  }, [enabled, localLastVisitedAt, settings.groups, showsThread, singleThreadOpens, threads]);

  // Opening a thread from a link, a notification or a new-thread action shows its tab, so the
  // open row is visible. Browsing other tabs while the thread stays open does not switch back.
  const followedRouteKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || routeThreadKey === null) return;
    if (followedRouteKeyRef.current === routeThreadKey) return;
    const thread = threads.find((candidate) => sidebarGroupThreadKey(candidate) === routeThreadKey);
    if (thread === undefined) return;
    followedRouteKeyRef.current = routeThreadKey;
    if (showsThread(tabId, thread)) return;
    const groupId = groupIdByThreadKey.get(routeThreadKey) ?? DEFAULT_SIDEBAR_GROUP_ID;
    // A single-thread tab stands for its thread, so it is visible without a switch.
    if (tabs.some((tab) => tab.id === groupId && tab.singleThread !== null)) return;
    setTabId(groupId);
  }, [enabled, groupIdByThreadKey, routeThreadKey, setTabId, showsThread, tabId, tabs, threads]);

  // Each write replaces the groups whole. Two quick edits chain through this ref, so the second
  // does not undo the first before the server echoes it. Edits from two devices at the same
  // moment still keep only the last one; revisit with per-group commands if that bites.
  const latestSettingsRef = useRef(savedSettings);
  useEffect(() => {
    latestSettingsRef.current = savedSettings;
  }, [savedSettings]);
  const update = useCallback(
    (change: (current: SidebarGroups) => SidebarGroups) => {
      const next = change(latestSettingsRef.current);
      latestSettingsRef.current = next;
      updatePrimarySettings({ sidebarGroups: next });
    },
    [updatePrimarySettings],
  );

  const assignThreads = useCallback(
    (threadKeys: readonly string[], groupId: string) =>
      update((current) => assignSidebarThreadsToGroup(current, threadKeys, groupId)),
    [update],
  );
  const createGroup = useCallback(
    (threadKeys: readonly string[]) => {
      const id = randomUUID();
      update((current) => createSidebarGroup(current, { id, threadKeys }));
      setTabId(id);
      return id;
    },
    [setTabId, update],
  );
  const renameGroup = useCallback(
    (groupId: string, name: string) => {
      const trimmed = name.trim();
      if (trimmed.length === 0) return;
      update((current) =>
        updateSidebarGroup(current, groupId, (group) => ({ ...group, name: trimmed })),
      );
    },
    [update],
  );
  const setGroupRules = useCallback(
    (groupId: string, rules: readonly SidebarGroupRule[]) =>
      update((current) => updateSidebarGroup(current, groupId, (group) => ({ ...group, rules }))),
    [update],
  );
  const deleteGroup = useCallback(
    (groupId: string) => update((current) => deleteSidebarGroup(current, groupId)),
    [update],
  );
  const moveGroup = useCallback(
    (groupId: string, toIndex: number) =>
      update((current) => moveSidebarGroup(current, groupId, toIndex)),
    [update],
  );

  return {
    enabled,
    settings,
    tabId,
    setTabId,
    tabs,
    visibleThreads,
    ruleOptions,
    assignThreads,
    createGroup,
    renameGroup,
    setGroupRules,
    deleteGroup,
    moveGroup,
  };
}
