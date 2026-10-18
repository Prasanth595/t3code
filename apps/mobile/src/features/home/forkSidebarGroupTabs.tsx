/**
 * Fork: the sidebar group tabs of web, above the home thread list, while a connected server has
 * `mobileSidebarGroups` on. The groups come from the server setting `sidebarGroups`, which the
 * machine map syncs, so web and mobile show the same groups. Tap a tab to show its threads, and
 * long-press it to edit, move or delete it.
 *
 * Known limits: a thread link does not switch to the tab of the thread, and web theme icon packs
 * do not apply. Revisit if users open threads from links on the phone often.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  buildSidebarGroupProjectFacts,
  compileSidebarGroups,
  deleteSidebarGroup,
  moveSidebarGroup,
  DEFAULT_SIDEBAR_GROUP_ID,
  resolveSidebarGroupTabStatus,
  resolveSidebarThreadGroupId,
  sidebarDefaultTabName,
  sidebarGroupShowsThread,
  sidebarGroupThreadKey,
  type SidebarGroupTabStatusKind,
} from "@t3tools/client-runtime/state/sidebarGroups";
import { effectiveSnoozed, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo } from "react";
import { Pressable, ScrollView } from "react-native";
import { useResolveClassNames } from "uniwind";

import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";

import { AppText } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  createMobileSidebarGroup,
  editSidebarGroups,
  sidebarGroupsAtom,
} from "../../state/forkSidebarGroups";
import { openSidebarGroupEditor } from "../settings/forkSidebarGroupEditor";
import { threadHasUnseenCompletion } from "../threads/threadListV2";
import { GroupIcon } from "./forkGroupIcons";

/** The icon and colour of the thread row status (`STATUS_LABEL_BY_STATUS` in thread-list-v2-items). */
const TAB_STATUS: Record<
  SidebarGroupTabStatusKind,
  { readonly icon: AppSymbolName; readonly tint: string }
> = {
  approval: { icon: "exclamationmark.shield", tint: "accent-warning-foreground" },
  input: { icon: "questionmark.bubble", tint: "accent-adaptive-indigo-600-300" },
  working: { icon: "circle.dashed", tint: "accent-adaptive-sky-600-400" },
  waiting: { icon: "circle.dashed.inset.filled", tint: "accent-foreground-muted" },
  failed: { icon: "exclamationmark.circle", tint: "accent-danger-foreground" },
  limited: { icon: "exclamationmark.circle", tint: "accent-warning-foreground" },
  woke: { icon: "clock", tint: "accent-warning-foreground" },
  done: { icon: "checkmark.circle", tint: "accent-adaptive-emerald-700-300" },
};

export interface HomeSidebarGroupTab {
  readonly id: string;
  readonly name: string;
  /** A web group icon id, `none`, or undefined for the default dot. */
  readonly icon: string | undefined;
  readonly showName: boolean;
  /** Threads that the tab shows, without the settled ones. */
  readonly threadCount: number;
  /** The status of the most urgent thread that is not asleep. */
  readonly status: SidebarGroupTabStatusKind | null;
}

export interface HomeSidebarGroups {
  readonly tabs: ReadonlyArray<HomeSidebarGroupTab>;
  readonly tabId: string;
  readonly selectTab: (tabId: string) => void;
  /** The threads of the open tab. Search covers every tab, so it sees every thread. */
  readonly filterThreads: (
    threads: ReadonlyArray<EnvironmentThreadShell>,
  ) => ReadonlyArray<EnvironmentThreadShell>;
}

/**
 * The tabs and the filter of the open tab, or null while no server has groups for the phone.
 * The work runs once per change of the groups, the projects, the threads or the clock, not once
 * per row.
 */
export function useHomeSidebarGroups(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  /** The list scope, so the tab counts match the list. */
  readonly environmentId: EnvironmentId | null;
  /** `scopedProjectKey` of each scoped project, or null for every project. */
  readonly projectKeys: ReadonlySet<string> | null;
  readonly searching: boolean;
  /** The list clock, so the tabs see snoozed threads wake. Minute precision is enough for a tab. */
  readonly now: string;
}): HomeSidebarGroups | null {
  const { threads, projects, environmentId, projectKeys, searching, now } = input;
  const settings = useAtomValue(sidebarGroupsAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const storedTabId = AsyncResult.isSuccess(preferences)
    ? preferences.value.sidebarGroupTabId
    : undefined;
  const tabId =
    settings !== null && settings.groups.some((group) => group.id === storedTabId)
      ? storedTabId!
      : DEFAULT_SIDEBAR_GROUP_ID;

  const compiled = useMemo(
    () => (settings === null ? null : compileSidebarGroups(settings)),
    [settings],
  );
  const facts = useMemo(() => buildSidebarGroupProjectFacts(projects), [projects]);
  const groupIdByThreadKey = useMemo(() => {
    if (compiled === null) return null;
    return new Map(
      threads.map((thread) => [
        sidebarGroupThreadKey(thread),
        resolveSidebarThreadGroupId(thread, compiled, facts),
      ]),
    );
  }, [compiled, facts, threads]);

  const showsThread = useCallback(
    (tab: string, thread: EnvironmentThreadShell) =>
      compiled !== null &&
      groupIdByThreadKey !== null &&
      sidebarGroupShowsThread({
        tabId: tab,
        thread,
        threadGroupId:
          groupIdByThreadKey.get(sidebarGroupThreadKey(thread)) ?? DEFAULT_SIDEBAR_GROUP_ID,
        compiled,
        projects: facts,
      }),
    [compiled, facts, groupIdByThreadKey],
  );

  const tabs = useMemo(() => {
    if (settings === null) return [];
    const states = threads
      .filter(
        (thread) =>
          thread.archivedAt === null &&
          thread.lineage.relationshipToParent !== "subagent" &&
          (environmentId === null || thread.environmentId === environmentId) &&
          (projectKeys === null ||
            projectKeys.has(scopedProjectKey(thread.environmentId, thread.projectId))),
      )
      .map((thread) => {
        const settled = thread.settledOverride === "settled";
        const wokeAt = threadWokeAt(thread, { now });
        return {
          thread,
          settled,
          asleep: settled || effectiveSnoozed(thread, { now }),
          isUnread: threadHasUnseenCompletion(thread),
          isWoke:
            wokeAt !== null &&
            !settled &&
            (thread.lastVisitedAt == null || Date.parse(thread.lastVisitedAt) < Date.parse(wokeAt)),
        };
      });
    const describe = (
      id: string,
      name: string,
      look: { readonly icon?: string | undefined; readonly showName?: boolean | undefined },
    ): HomeSidebarGroupTab => {
      const shown = states.filter((state) => showsThread(id, state.thread));
      return {
        id,
        name,
        icon: look.icon,
        showName: look.showName !== false,
        threadCount: shown.filter((state) => !state.settled).length,
        status: resolveSidebarGroupTabStatus(shown.filter((state) => !state.asleep)),
      };
    };
    return [
      describe(DEFAULT_SIDEBAR_GROUP_ID, sidebarDefaultTabName(settings), settings.defaultTab),
      ...settings.groups.map((group) => describe(group.id, group.name, group)),
    ];
  }, [environmentId, now, projectKeys, settings, showsThread, threads]);

  const selectTab = useCallback(
    (next: string) => savePreferences({ sidebarGroupTabId: next }),
    [savePreferences],
  );
  const filterThreads = useCallback(
    (list: ReadonlyArray<EnvironmentThreadShell>) =>
      searching ? list : list.filter((thread) => showsThread(tabId, thread)),
    [searching, showsThread, tabId],
  );

  return useMemo(
    () => (settings === null ? null : { tabs, tabId, selectTab, filterThreads }),
    [filterThreads, selectTab, settings, tabId, tabs],
  );
}

export function HomeSidebarGroupTabBar(props: { readonly groups: HomeSidebarGroups }) {
  const { tabs, tabId, selectTab } = props.groups;
  const navigation = useNavigation();
  const { color: selectedColor } = useResolveClassNames("text-foreground");
  const { color: mutedColor } = useResolveClassNames("text-foreground-muted");
  const groupCount = tabs.length - 1;
  const handleTabAction = (tab: HomeSidebarGroupTab, groupIndex: number, event: string) => {
    if (event === "edit") openSidebarGroupEditor(navigation, tab.id);
    if (event === "move-left")
      editSidebarGroups((s) => moveSidebarGroup(s, tab.id, groupIndex - 1));
    if (event === "move-right")
      editSidebarGroups((s) => moveSidebarGroup(s, tab.id, groupIndex + 1));
    if (event === "delete") {
      Dialog.confirm({
        title: `Delete ${tab.name}?`,
        message: "Its threads go back to the rules or to the first tab.",
        confirmText: "Delete",
        destructive: true,
        onConfirm: () => {
          if (tabId === tab.id) selectTab(DEFAULT_SIDEBAR_GROUP_ID);
          editSidebarGroups((s) => deleteSidebarGroup(s, tab.id));
        },
      });
    }
  };
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 px-4 pb-2"
      keyboardShouldPersistTaps="handled"
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === tabId;
        const status = tab.status === null ? null : TAB_STATUS[tab.status];
        const groupIndex = index - 1;
        return (
          <Menu
            key={tab.id}
            shouldOpenOnLongPress
            actions={tabMenuActions(groupIndex, groupCount)}
            onPressAction={({ nativeEvent }) => handleTabAction(tab, groupIndex, nativeEvent.event)}
          >
            <Pressable
              accessibilityRole="tab"
              accessibilityLabel={`${tab.name}, ${tab.threadCount} threads`}
              accessibilityHint="Long-press to edit the group"
              accessibilityState={{ selected }}
              onPress={() => selectTab(tab.id)}
              className={cn(
                "h-9 flex-row items-center gap-1.5 rounded-full px-3 active:opacity-70",
                selected ? "bg-subtle" : "bg-transparent",
              )}
            >
              <GroupIcon icon={tab.icon} size={16} color={selected ? selectedColor : mutedColor} />
              {tab.showName || tab.icon === "none" ? (
                <AppText
                  className={cn(
                    "text-sm font-t3-medium",
                    selected ? "text-foreground" : "text-foreground-muted",
                  )}
                >
                  {tab.name}
                </AppText>
              ) : null}
              {status ? (
                <SymbolView name={status.icon} size={14} tintColorClassName={status.tint} />
              ) : tab.threadCount > 0 ? (
                <AppText className="text-xs text-foreground-muted">{tab.threadCount}</AppText>
              ) : null}
            </Pressable>
          </Menu>
        );
      })}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New group"
        onPress={() => {
          const id = createMobileSidebarGroup();
          selectTab(id);
          openSidebarGroupEditor(navigation, id);
        }}
        className="size-9 items-center justify-center rounded-full active:opacity-70"
      >
        <SymbolView name="plus" size={16} tintColorClassName="accent-foreground-muted" />
      </Pressable>
    </ScrollView>
  );
}

/** The long-press menu of a tab. The first tab has no position and cannot be deleted. */
function tabMenuActions(groupIndex: number, groupCount: number): MenuAction[] {
  const edit: MenuAction = { id: "edit", title: "Edit", image: "slider.horizontal.3" };
  if (groupIndex < 0) return [edit];
  return [
    edit,
    ...(groupIndex > 0 ? [{ id: "move-left", title: "Move left", image: "chevron.left" }] : []),
    ...(groupIndex < groupCount - 1
      ? [{ id: "move-right", title: "Move right", image: "chevron.right" }]
      : []),
    { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
  ];
}
