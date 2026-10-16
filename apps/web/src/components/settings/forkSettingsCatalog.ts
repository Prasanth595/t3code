import type { SettingsSearchItem, SettingsSearchItemId } from "./settingsSearch";

/**
 * One setting on the Fork page. `ids` are the search ids of the rows of one row component; the
 * first one is the link to the usual place. An upstream setting that the fork changed has a
 * `change` note. A `linkOnly` entry is an upstream row that is not its own component: the page
 * shows its title, the note and a link to it.
 */
type ForkSettingEntry =
  | {
      readonly ids: readonly [SettingsSearchItemId, ...SettingsSearchItemId[]];
      readonly change?: string;
    }
  | {
      readonly ids: readonly [SettingsSearchItemId];
      readonly change: string;
      readonly linkOnly: true;
    };

/**
 * Fork: every fork setting and every upstream setting that the fork changed, in the groups of
 * the README "Fork features" section. Add a new fork setting here and its row component in
 * `FORK_SETTING_ROWS` (ForkSettings.tsx). This module imports no components, so the settings
 * search can read it without loading the settings pages.
 */
const FORK_SETTING_GROUPS = [
  {
    title: "Remote access",
    entries: [{ ids: ["tunnel-pairing"] }],
  },
  {
    title: "Machine map",
    entries: [{ ids: ["machine-map"] }],
  },
  {
    title: "Updates and releases",
    entries: [
      {
        ids: ["update-track", "app-version"],
        change:
          "Fork: installs fork releases, never downgrades, and offers Install when idle while agents run.",
      },
      { ids: ["fork-auto-update"] },
      { ids: ["fork-changelog"] },
    ],
  },
  {
    title: "Agents",
    entries: [
      { ids: ["recover-interrupted-turns"] },
      {
        ids: ["continue-threads-after-server-update"],
        change:
          "Fork: while Recover interrupted agents is on, cut-off threads continue also when this is off.",
        linkOnly: true,
      },
      { ids: ["background-work-details"] },
      { ids: ["prefer-origin-remote"] },
      {
        ids: [
          "pull-request-watch-roles",
          "pull-request-watch-logins",
          "pull-request-watch-agent-marker",
        ],
      },
      { ids: ["agent-session-import-window", "agent-session-import-max-messages"] },
    ],
  },
  {
    title: "Threads",
    entries: [
      { ids: ["sidebar-groups", "sidebar-group-single-thread"] },
      { ids: ["snooze-quick-options"] },
      { ids: ["storage-worktree-path-template"] },
      {
        ids: ["storage-worktrees-location"],
        change: "Fork: a worktree path template, when set, replaces this location.",
      },
    ],
  },
  {
    title: "Filters",
    entries: [{ ids: ["repository-owner-filters"] }, { ids: ["pull-request-filter-chips"] }],
  },
  {
    title: "Scripts and terminal",
    entries: [
      { ids: ["global-scripts"] },
      { ids: ["app-toggle-shortcuts"] },
      { ids: ["terminal-app-shortcuts-first"] },
      { ids: ["terminal-close-confirmation"] },
    ],
  },
  {
    title: "Web app and look",
    entries: [
      { ids: ["installed-app"] },
      { ids: ["thread-card-layout"] },
      { ids: ["thread-link-chips"] },
    ],
  },
] as const satisfies ReadonlyArray<{
  readonly title: string;
  readonly entries: ReadonlyArray<ForkSettingEntry>;
}>;

type ForkSettingCatalogEntry = (typeof FORK_SETTING_GROUPS)[number]["entries"][number];

/** The first search id of each entry that renders a row component. */
export type ForkSettingRowId = Exclude<
  ForkSettingCatalogEntry,
  { readonly linkOnly: true }
>["ids"][0];

export const forkSettingGroups: ReadonlyArray<{
  readonly title: string;
  readonly entries: ReadonlyArray<ForkSettingCatalogEntry>;
}> = FORK_SETTING_GROUPS;

/**
 * Search results for the rows of the Fork page. Each one copies the result of the usual place,
 * so it has the same scope and availability, and sorts after it.
 */
export function forkSettingsSearchItems(
  available: ReadonlyArray<SettingsSearchItem>,
): ReadonlyArray<SettingsSearchItem> {
  const availableById = new Map(available.map((item) => [item.id, item] as const));
  return forkSettingGroups.flatMap((group) =>
    group.entries.flatMap((entry) =>
      entry.ids.flatMap((id) => {
        const item = availableById.get(id);
        if (item === undefined) return [];
        return [
          {
            ...item,
            id: `fork-${item.id}`,
            targetId: item.id,
            to: "/settings/fork" as const,
            secondary: true,
          },
        ];
      }),
    ),
  );
}
