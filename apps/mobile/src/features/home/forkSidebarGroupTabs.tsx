/**
 * Fork: the sidebar group tabs of web, above the home thread list, while a connected server has
 * `mobileSidebarGroups` on. The groups come from the server setting `sidebarGroups`, which the
 * machine map syncs, so web and mobile show the same groups. Tap a tab to show its threads.
 *
 * Known limits: the tabs cannot be edited here, a thread link does not switch to the tab of the
 * thread, and web theme icon packs do not apply. Revisit when mobile edits groups.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Icon } from "@tabler/icons-react-native/types";
import IconArchive from "@tabler/icons-react-native/IconArchive";
import IconBell from "@tabler/icons-react-native/IconBell";
import IconBolt from "@tabler/icons-react-native/IconBolt";
import IconBook from "@tabler/icons-react-native/IconBook";
import IconBookmark from "@tabler/icons-react-native/IconBookmark";
import IconBox from "@tabler/icons-react-native/IconBox";
import IconBriefcase from "@tabler/icons-react-native/IconBriefcase";
import IconBug from "@tabler/icons-react-native/IconBug";
import IconCalendar from "@tabler/icons-react-native/IconCalendar";
import IconClock from "@tabler/icons-react-native/IconClock";
import IconCloud from "@tabler/icons-react-native/IconCloud";
import IconCode from "@tabler/icons-react-native/IconCode";
import IconDatabase from "@tabler/icons-react-native/IconDatabase";
import IconEye from "@tabler/icons-react-native/IconEye";
import IconFlag from "@tabler/icons-react-native/IconFlag";
import IconFlame from "@tabler/icons-react-native/IconFlame";
import IconFolder from "@tabler/icons-react-native/IconFolder";
import IconGitBranch from "@tabler/icons-react-native/IconGitBranch";
import IconHeart from "@tabler/icons-react-native/IconHeart";
import IconHome from "@tabler/icons-react-native/IconHome";
import IconInbox from "@tabler/icons-react-native/IconInbox";
import IconPointFilled from "@tabler/icons-react-native/IconPointFilled";
import IconRobot from "@tabler/icons-react-native/IconRobot";
import IconRocket from "@tabler/icons-react-native/IconRocket";
import IconServer from "@tabler/icons-react-native/IconServer";
import IconShield from "@tabler/icons-react-native/IconShield";
import IconSparkles from "@tabler/icons-react-native/IconSparkles";
import IconStack2 from "@tabler/icons-react-native/IconStack2";
import IconStar from "@tabler/icons-react-native/IconStar";
import IconTag from "@tabler/icons-react-native/IconTag";
import IconTerminal2 from "@tabler/icons-react-native/IconTerminal2";
import IconTool from "@tabler/icons-react-native/IconTool";
import IconWorld from "@tabler/icons-react-native/IconWorld";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  buildSidebarGroupProjectFacts,
  compileSidebarGroups,
  DEFAULT_SIDEBAR_GROUP_ID,
  resolveSidebarGroupTabStatus,
  resolveSidebarThreadGroupId,
  sidebarDefaultTabName,
  sidebarGroupShowsThread,
  sidebarGroupThreadKey,
  type SidebarGroupTabStatusKind,
} from "@t3tools/client-runtime/state/sidebarGroups";
import { effectiveSnoozed, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, SidebarGroups } from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";
import { Pressable, ScrollView } from "react-native";
import { useResolveClassNames } from "uniwind";

import { AppText } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadHasUnseenCompletion } from "../threads/threadListV2";

/** The web group icon ids (`GROUP_ICONS` in web `AppIcon.tsx`), with Tabler icons. */
const GROUP_ICONS: Record<string, Icon> = {
  dot: IconPointFilled,
  star: IconStar,
  heart: IconHeart,
  bolt: IconBolt,
  flame: IconFlame,
  sparkles: IconSparkles,
  rocket: IconRocket,
  bug: IconBug,
  wrench: IconTool,
  code: IconCode,
  terminal: IconTerminal2,
  bot: IconRobot,
  branch: IconGitBranch,
  eye: IconEye,
  clock: IconClock,
  calendar: IconCalendar,
  bell: IconBell,
  flag: IconFlag,
  bookmark: IconBookmark,
  tag: IconTag,
  inbox: IconInbox,
  archive: IconArchive,
  folder: IconFolder,
  layers: IconStack2,
  box: IconBox,
  briefcase: IconBriefcase,
  home: IconHome,
  book: IconBook,
  globe: IconWorld,
  cloud: IconCloud,
  server: IconServer,
  database: IconDatabase,
  shield: IconShield,
};

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

let previousGroups: SidebarGroups | null = null;

/**
 * The groups of the first connected server with `mobileSidebarGroups` on and at least one group,
 * or null. The previous value stays while the groups are equal, so a config snapshot that does
 * not change them renders nothing.
 */
const sidebarGroupsAtom = Atom.make((get): SidebarGroups | null => {
  const configs = [...get(environmentServerConfigsAtom).values()];
  const next =
    configs.find(
      (config) =>
        config.settings.mobileSidebarGroups && config.settings.sidebarGroups.groups.length > 0,
    )?.settings.sidebarGroups ?? null;
  if (next === null) return null;
  if (previousGroups !== null && Equal.equals(previousGroups, next)) return previousGroups;
  previousGroups = next;
  return next;
}).pipe(Atom.withLabel("mobile:fork-sidebar-groups"));

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
  const { color: selectedColor } = useResolveClassNames("text-foreground");
  const { color: mutedColor } = useResolveClassNames("text-foreground-muted");
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 px-4 pb-2"
      keyboardShouldPersistTaps="handled"
    >
      {tabs.map((tab) => {
        const selected = tab.id === tabId;
        const TabIcon =
          tab.icon === "none" ? null : (GROUP_ICONS[tab.icon ?? "dot"] ?? IconPointFilled);
        const status = tab.status === null ? null : TAB_STATUS[tab.status];
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityLabel={`${tab.name}, ${tab.threadCount} threads`}
            accessibilityState={{ selected }}
            onPress={() => selectTab(tab.id)}
            className={cn(
              "h-9 flex-row items-center gap-1.5 rounded-full px-3 active:opacity-70",
              selected ? "bg-subtle" : "bg-transparent",
            )}
          >
            {TabIcon ? (
              <TabIcon size={16} strokeWidth={2} color={selected ? selectedColor : mutedColor} />
            ) : null}
            {tab.showName || TabIcon === null ? (
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
        );
      })}
    </ScrollView>
  );
}
