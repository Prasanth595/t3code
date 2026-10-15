/**
 * Fork: the state of the sidebar thread groups, kept out of `Sidebar.tsx` so that the upstream
 * file changes little. The groups live in the server setting `sidebarGroups` of the primary
 * environment, and the machine map owns their sync: a change saves on the primary, then becomes
 * the shared value of the map (MM-411), which every machine applies.
 */
import type { SidebarGroup, SidebarGroupRuleField, SidebarGroups } from "@t3tools/contracts";
import { effectiveSnoozed, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { randomUUID } from "~/lib/utils";
import {
  useClientSettings,
  usePrimarySettings,
  usePrimarySettingsAvailable,
} from "../../hooks/useSettings";
import { useShareServerSettingsToMachineMap } from "../../machineMap/shareSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerConfigAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import {
  filterSidebarV2VisibleThreads,
  hasUnseenCompletion,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import { toastManager } from "../ui/toast";
import { filterSidebarThreadsByOwner } from "./ownerFilter.logic";
import { useSidebarGroupTabStore } from "./sidebarGroupTabStore";
import {
  buildSidebarGroupProjectFacts,
  buildSidebarGroupRuleOptions,
  createSidebarGroup,
  DEFAULT_SIDEBAR_GROUP_ID,
  DEFAULT_SIDEBAR_GROUP_NAME,
  deleteSidebarGroup,
  isSidebarGroupView,
  moveSidebarGroup,
  moveSidebarThreads,
  pruneSidebarGroupAssignments,
  resolveSidebarGroupTabStatus,
  resolveSidebarThreadGroupId,
  SIDEBAR_GROUP_ATTENTION_STATUSES,
  sidebarGroupShowsThread,
  sidebarGroupThreadKey,
  updateSidebarGroup,
} from "./sidebarGroups.logic";
import { sidebarGroupTabStatus, type SidebarGroupTabStatus } from "./sidebarGroupStatus";

/** The data attribute that marks a drop target in the tab bar: a tab id, or `new`. */
export const SIDEBAR_GROUP_DROP_ATTRIBUTE = "data-sidebar-group-drop";
export const SIDEBAR_GROUP_DROP_NEW = "new";

export interface SidebarGroupTab {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly isView: boolean;
  /** Threads that the tab shows, without the settled ones. */
  readonly threadCount: number;
  /** The status of the most urgent thread that is not asleep. */
  readonly status: SidebarGroupTabStatus | null;
  readonly needsAttention: boolean;
  /** The one thread of the tab, when a click on the tab opens it. */
  readonly singleThread: SidebarThreadSummary | null;
}

const EMPTY_SETTINGS: SidebarGroups = { groups: [], assignments: {} };

export function useSidebarGroups(input: {
  /** Every thread shell, before any filter. */
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly ownerVisibleProjectKeys: ReadonlySet<string> | null;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly routeThreadKey: string | null;
  /** Search covers every tab. */
  readonly searching: boolean;
  /** Changes at each snooze wake, so the tab statuses see woken threads. */
  readonly snoozeWakeTick: number;
}) {
  const { routeThreadKey, searching, snoozeWakeTick } = input;
  const enabledOnDevice = useClientSettings((s) => s.sidebarGroupsEnabled);
  // The hosted app has no primary server to hold the groups, so it shows none.
  const primaryAvailable = usePrimarySettingsAvailable();
  const enabled = enabledOnDevice && primaryAvailable;
  const savedSettings = usePrimarySettings((s) => s.sidebarGroups);
  // Until the primary config arrives, the groups read as empty, and every thread looks ungrouped.
  const ready = useAtomValue(primaryServerConfigAtom) !== null;
  const singleThreadOpens = useClientSettings((s) => s.sidebarGroupSingleThreadOpens);
  const settings = enabled ? savedSettings : EMPTY_SETTINGS;
  const storedTabId = useSidebarGroupTabStore((s) => s.tabId);
  const setTabId = useSidebarGroupTabStore((s) => s.setTabId);
  const tabId =
    enabled && settings.groups.some((group) => group.id === storedTabId)
      ? storedTabId
      : DEFAULT_SIDEBAR_GROUP_ID;

  const projects = useMemo(() => buildSidebarGroupProjectFacts(input.projects), [input.projects]);
  // Non-archived sidebar threads: what the groups hold and what an assignment can name.
  const liveThreads = useMemo(
    () => filterSidebarV2VisibleThreads(input.threads, null),
    [input.threads],
  );
  const threads = useMemo(
    () =>
      filterSidebarV2VisibleThreads(
        filterSidebarThreadsByOwner(input.threads, input.ownerVisibleProjectKeys),
        input.scopedProjectKeys,
      ),
    [input.ownerVisibleProjectKeys, input.scopedProjectKeys, input.threads],
  );

  const groupIdByThreadKey = useMemo(
    () =>
      new Map(
        threads.map((thread) => [
          sidebarGroupThreadKey(thread),
          resolveSidebarThreadGroupId(thread, settings, projects),
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

  // A tab switch drops the selection, like a scope flip: hidden rows must not stay selected.
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const previousTabIdRef = useRef(tabId);
  useEffect(() => {
    if (previousTabIdRef.current === tabId) return;
    previousTabIdRef.current = tabId;
    clearSelection();
  }, [clearSelection, tabId]);

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
    void snoozeWakeTick;
    const now = new Date().toISOString();
    const states = threads.map((thread, index) => {
      const lastVisitedAt = resolveThreadLastVisitedAt(
        thread.lastVisitedAt,
        localLastVisitedAt[index],
      );
      const wokeAt = threadWokeAt(thread, { now });
      const settled = thread.settledOverride === "settled";
      return {
        thread,
        settled,
        asleep: settled || effectiveSnoozed(thread, { now }),
        isUnread: hasUnseenCompletion({ ...thread, lastVisitedAt }),
        isWoke:
          wokeAt !== null &&
          !settled &&
          (lastVisitedAt === undefined || Date.parse(lastVisitedAt) < Date.parse(wokeAt)),
      };
    });
    const describe = (id: string, name: string, group: SidebarGroup | null): SidebarGroupTab => {
      const shown = states.filter((state) => showsThread(id, state.thread));
      const open = shown.filter((state) => !state.settled);
      const kind = resolveSidebarGroupTabStatus(shown.filter((state) => !state.asleep));
      return {
        id,
        name,
        isDefault: group === null,
        isView: group !== null && isSidebarGroupView(group),
        threadCount: open.length,
        status: kind === null ? null : sidebarGroupTabStatus(kind),
        needsAttention: kind !== null && SIDEBAR_GROUP_ATTENTION_STATUSES.has(kind),
        singleThread:
          singleThreadOpens && group !== null && open.length === 1 ? open[0]!.thread : null,
      };
    };
    return [
      describe(DEFAULT_SIDEBAR_GROUP_ID, DEFAULT_SIDEBAR_GROUP_NAME, null),
      ...settings.groups.map((group) => describe(group.id, group.name, group)),
    ];
  }, [
    enabled,
    localLastVisitedAt,
    settings.groups,
    showsThread,
    singleThreadOpens,
    snoozeWakeTick,
    threads,
  ]);

  // Opening a thread from a link, a notification or a new-thread action shows its tab, so the
  // open row is visible. Browsing other tabs while the thread stays open does not switch back.
  // It waits for the groups: before they load, every thread resolves to the default tab.
  const followedRouteKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !ready || routeThreadKey === null) return;
    if (followedRouteKeyRef.current === routeThreadKey) return;
    const thread = threads.find((candidate) => sidebarGroupThreadKey(candidate) === routeThreadKey);
    if (thread === undefined) return;
    followedRouteKeyRef.current = routeThreadKey;
    if (showsThread(tabId, thread)) return;
    const groupId = groupIdByThreadKey.get(routeThreadKey) ?? DEFAULT_SIDEBAR_GROUP_ID;
    // A single-thread tab stands for its thread, so it is visible without a switch.
    if (tabs.some((tab) => tab.id === groupId && tab.singleThread !== null)) return;
    setTabId(groupId);
  }, [
    enabled,
    groupIdByThreadKey,
    ready,
    routeThreadKey,
    setTabId,
    showsThread,
    tabId,
    tabs,
    threads,
  ]);

  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const persist = useAtomCommand(serverEnvironment.updateSettings, {
    label: "sidebar groups update",
    reportFailure: false,
  });
  const shareToMachineMap = useShareServerSettingsToMachineMap();
  // Each write replaces the groups whole. Two quick edits chain through this ref, so the second
  // does not undo the first before the server echoes it. Edits from two devices at the same
  // moment still keep only the last one; revisit with per-group commands if that bites.
  const latestSettingsRef = useRef(savedSettings);
  useEffect(() => {
    latestSettingsRef.current = savedSettings;
  }, [savedSettings]);
  const update = useCallback(
    (change: (current: SidebarGroups) => SidebarGroups) => {
      if (primaryEnvironmentId === null || !ready) return;
      const current = latestSettingsRef.current;
      const next = pruneSidebarGroupAssignments(change(current), liveThreads, projects);
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      latestSettingsRef.current = next;
      void persist({
        environmentId: primaryEnvironmentId,
        input: { patch: { sidebarGroups: next } },
      }).then((result) => {
        if (result._tag === "Success") {
          shareToMachineMap(primaryEnvironmentId, ["sidebarGroups"]);
          return;
        }
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Groups not saved",
          description:
            error instanceof Error ? error.message : "Try reconnecting and saving again.",
        });
      });
    },
    [liveThreads, persist, primaryEnvironmentId, projects, ready, shareToMachineMap],
  );

  const threadsForRefs = useCallback(
    (threadKeys: readonly string[]) => {
      const keys = new Set(threadKeys);
      return liveThreads.filter((thread) => keys.has(sidebarGroupThreadKey(thread)));
    },
    [liveThreads],
  );

  const createGroup = useCallback(
    (threadKeys: readonly string[]) => {
      const id = randomUUID();
      update((current) =>
        moveSidebarThreads(
          createSidebarGroup(current, id),
          threadsForRefs(threadKeys),
          id,
          projects,
        ),
      );
      setTabId(id);
      return id;
    },
    [projects, setTabId, threadsForRefs, update],
  );

  // The tab or the new-group area under a dragged thread. A view takes no drop: it holds no threads.
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  const dropTargetAt = useCallback(
    (point: { x: number; y: number }) => {
      if (!enabled) return null;
      const target =
        document
          .elementFromPoint(point.x, point.y)
          ?.closest(`[${SIDEBAR_GROUP_DROP_ATTRIBUTE}]`)
          ?.getAttribute(SIDEBAR_GROUP_DROP_ATTRIBUTE) ?? null;
      return target === SIDEBAR_GROUP_DROP_NEW ||
        tabsRef.current.some((tab) => tab.id === target && !tab.isView)
        ? target
        : null;
    },
    [enabled],
  );
  /** Tracks the drop target under a dragged thread. True when the tab bar takes the move. */
  const moveDrag = useCallback(
    (point: { x: number; y: number }) => {
      const target = dropTargetAt(point);
      setDropTargetId(target);
      return target !== null;
    },
    [dropTargetAt],
  );
  /** Drops dragged threads on the tab bar. True when the tab bar took the drop. */
  const dropDrag = useCallback(
    (point: { x: number; y: number }, threadKeys: readonly string[]) => {
      const target = dropTargetAt(point);
      setDropTargetId(null);
      if (target === null) return false;
      if (target === SIDEBAR_GROUP_DROP_NEW) createGroup(threadKeys);
      else
        update((current) =>
          moveSidebarThreads(current, threadsForRefs(threadKeys), target, projects),
        );
      return true;
    },
    [createGroup, dropTargetAt, projects, threadsForRefs, update],
  );
  const endDrag = useCallback(() => setDropTargetId(null), []);

  const ruleOptions = useCallback(
    (field: Exclude<SidebarGroupRuleField, "title">, groupId: string) =>
      buildSidebarGroupRuleOptions({ field, groupId, threads, projects, settings }),
    [projects, settings, threads],
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
    (groupId: string, rules: SidebarGroup["rules"]) =>
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
    dropTargetId,
    moveDrag,
    dropDrag,
    endDrag,
    createGroup,
    renameGroup,
    setGroupRules,
    deleteGroup,
    moveGroup,
  };
}

export type SidebarGroupsState = ReturnType<typeof useSidebarGroups>;
