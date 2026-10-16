/**
 * Fork settings. `settings.ts` spreads these fields into the upstream settings schemas, so the
 * upstream file keeps one line per schema and a Fork Sync merge does not conflict with them.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProjectScript } from "./project.ts";
import { PullRequestAuthorAssociation } from "./pullRequest.ts";
import { SidebarGroups } from "./sidebarGroups.ts";
import { StoredThreadCardLayout, ThreadCardLayouts } from "./slotLayout.ts";

/** Fork: the value of the `sidebarOwnerFilter` client setting. */
export const SidebarOwnerFilter = Schema.Struct({
  operator: Schema.Literals(["is", "is_not"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("is" as const)),
  ),
  owners: Schema.Array(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type SidebarOwnerFilter = typeof SidebarOwnerFilter.Type;
/** Fork: a local time of day for a snooze quick option. */
const SnoozeQuickOptionTime = Schema.Struct({
  hour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
  minute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 59 })),
});
export const SnoozeQuickOptionDay = Schema.Literals([
  "today",
  "tomorrow",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
export type SnoozeQuickOptionDay = typeof SnoozeQuickOptionDay.Type;
/**
 * Fork: one entry of the `snoozeQuickOptions` client setting. "in" snoozes for a duration. "at"
 * snoozes until a local time today, tomorrow, or on the next given weekday. Limit: a desktop shell
 * fails to read the client settings when an entry has a kind that its schema does not know.
 * Revisit before a new kind: release the shell before the web client writes that kind.
 */
export const SnoozeQuickOption = Schema.Union([
  Schema.TaggedStruct("in", {
    amount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999 })),
    unit: Schema.Literals(["minutes", "hours", "days"]),
    label: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.TaggedStruct("at", {
    day: SnoozeQuickOptionDay,
    time: SnoozeQuickOptionTime,
    label: Schema.optionalKey(TrimmedNonEmptyString),
  }),
]);
export type SnoozeQuickOption = typeof SnoozeQuickOption.Type;
export const MAX_SNOOZE_QUICK_OPTIONS = 10;
const SnoozeQuickOptions = Schema.NullOr(
  Schema.Array(SnoozeQuickOption).check(Schema.isMaxLength(MAX_SNOOZE_QUICK_OPTIONS)),
);

export const MIN_AGENT_SESSION_IMPORT_WINDOW_DAYS = 1;
export const MAX_AGENT_SESSION_IMPORT_WINDOW_DAYS = 3650;
/** How far back recent Claude Code and Codex sessions are offered for import. */
export const AgentSessionImportWindowDays = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_AGENT_SESSION_IMPORT_WINDOW_DAYS,
    maximum: MAX_AGENT_SESSION_IMPORT_WINDOW_DAYS,
  }),
);
export type AgentSessionImportWindowDays = typeof AgentSessionImportWindowDays.Type;
const DEFAULT_AGENT_SESSION_IMPORT_WINDOW_DAYS: AgentSessionImportWindowDays = 30;
export const MIN_AGENT_SESSION_IMPORT_MAX_MESSAGES = 1;
// The scanner's 32 MiB selected-history budget still bounds memory above this cap.
export const MAX_AGENT_SESSION_IMPORT_MAX_MESSAGES = 10_000;
/** Newest messages kept per imported session; the first user message is always kept. */
export const AgentSessionImportMaxMessages = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_AGENT_SESSION_IMPORT_MAX_MESSAGES,
    maximum: MAX_AGENT_SESSION_IMPORT_MAX_MESSAGES,
  }),
);
export type AgentSessionImportMaxMessages = typeof AgentSessionImportMaxMessages.Type;
export const DEFAULT_AGENT_SESSION_IMPORT_MAX_MESSAGES: AgentSessionImportMaxMessages = 200;

/**
 * Fork: client access of the machine map (MM-916). `off`: a browser that passes Cloudflare
 * Access as the owner gets the owner access, as before. `observe`: the browser proves its key; a
 * key that an approved client holds gets that client's arrow, at most `standard`, and any other
 * key keeps the owner access and waits in the portal for approval. `enforce` (MM-918): only a key
 * of an approved client gets in, with the full level of its arrow.
 */
export const ClientAccessMode = Schema.Literals(["off", "observe", "enforce"]);
export type ClientAccessMode = typeof ClientAccessMode.Type;

/**
 * Fork: which pull request remarks wake an agent that watches the pull request. With no roles
 * and no logins, a remark wakes the agent unless the server's own account wrote it.
 */
export const PullRequestWatchRemarkFilter = Schema.Struct({
  /**
   * Repository roles whose remarks wake the agent, as the host reports them. A remark from one of
   * these roles or from `authorLogins` wakes the agent; with either list set, the own-account
   * rule does not apply. A remark without a reported role counts only through `authorLogins`.
   */
  authorAssociations: Schema.Array(PullRequestAuthorAssociation).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Logins whose remarks wake the agent whatever their role, compared without case. */
  authorLogins: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Text that marks an agent's remark, such as `<!-- agent -->`. A remark with it never wakes. */
  agentMarker: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type PullRequestWatchRemarkFilter = typeof PullRequestWatchRemarkFilter.Type;

export const DEFAULT_MACHINE_MAP_PORTAL_URL = "https://t3.yarden-zamir.com";

/**
 * Fork: machine map (`apps/machine-map/SPEC.md`, MM-1301). Off means no portal connection and no
 * change to auth. The machine token lives in the server secret store, never here (MM-1302).
 */
export const MachineMapSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  portalUrl: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MACHINE_MAP_PORTAL_URL)),
  ),
});
export type MachineMapSettings = typeof MachineMapSettings.Type;

export const ForkClientSettingsFields = {
  confirmTerminalClose: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Fork: a focused terminal hands keys that match an app keybinding to the app first. */
  terminalAppShortcutsFirst: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Fork: global shortcuts that show or hide the desktop app, as Electron accelerators such as
   * `F17`. Plain strings, so one bad entry cannot make the whole settings document unreadable;
   * the desktop app skips an entry that Electron rejects.
   */
  appToggleShortcuts: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Fork: background work status icons open a details popover; their descriptions render markdown links. */
  backgroundWorkDetails: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Fork: a changelog of fork releases, upstream changes and Fork Sync runs from the update UI. */
  forkChangelogEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Fork: the web app registers a service worker for the installed app (`apps/web/public/sw.js`):
   * an offline page, notifications on Android and iOS, and the badge on the app icon.
   */
  installedAppEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Fork: with the installed app on and system notifications allowed, this browser subscribes to
   * Web Push on each connected server, so thread notifications arrive while the app is closed.
   */
  webPushEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Fork: filter by repository owner (`repositoryOwnerOf`) on the pull request page and in the
   * sidebar. Remove when upstream T3 Code ships its own owner or organization filter.
   */
  repositoryOwnerFilters: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Fork: the active pull request filters show as chips above the list, and an empty list names
   * the filters that emptied it. Remove when upstream T3 Code shows its active filters itself.
   */
  pullRequestFilterChips: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Fork: the sidebar filter by repository owner. "is" shows only the projects of these owners,
   * and "is_not" hides them. Null stands for projects without an owner. No owners shows every
   * project. Applies only while `repositoryOwnerFilters` is on.
   */
  sidebarOwnerFilter: SidebarOwnerFilter.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /**
   * Fork: thread groups as tabs above the sidebar list, on this device. A thread lives in the
   * group that the user dragged it into, else in the first group whose rules match it, else in the
   * default tab. The groups are the server setting `sidebarGroups`.
   */
  sidebarGroupsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Fork: a click on the tab of a group with one thread opens that thread. */
  sidebarGroupSingleThreadOpens: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  /**
   * Fork: the quick options of the web and desktop snooze menus, in menu order. Null keeps the
   * built-in options. The mobile app always shows the built-in options.
   */
  snoozeQuickOptions: SnoozeQuickOptions.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
};

export const ForkClientSettingsPatchFields = {
  confirmTerminalClose: Schema.optionalKey(Schema.Boolean),
  terminalAppShortcutsFirst: Schema.optionalKey(Schema.Boolean),
  appToggleShortcuts: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  backgroundWorkDetails: Schema.optionalKey(Schema.Boolean),
  forkChangelogEnabled: Schema.optionalKey(Schema.Boolean),
  installedAppEnabled: Schema.optionalKey(Schema.Boolean),
  webPushEnabled: Schema.optionalKey(Schema.Boolean),
  repositoryOwnerFilters: Schema.optionalKey(Schema.Boolean),
  pullRequestFilterChips: Schema.optionalKey(Schema.Boolean),
  sidebarOwnerFilter: Schema.optionalKey(SidebarOwnerFilter),
  sidebarGroupsEnabled: Schema.optionalKey(Schema.Boolean),
  sidebarGroupSingleThreadOpens: Schema.optionalKey(Schema.Boolean),
  snoozeQuickOptions: Schema.optionalKey(SnoozeQuickOptions),
};

export const ForkServerSettingsFields = {
  /**
   * Fork: where new worktrees go, such as `{repoDir}/{branchLeaf}`. Empty
   * keeps the `worktreesDirectory` layout. See docs/fork.md.
   */
  worktreePathTemplate: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * Fork: after a restart or crash, send each thread that the restart cut off a
   * recovery message. Unlike `continueThreadsAfterServerUpdate`, this also wakes
   * a thread whose finished turn left background work (native subagents,
   * monitors, background shells) that the restart killed.
   */
  recoverInterruptedTurns: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Fork: the message `recoverInterruptedTurns` sends to a top-level thread. */
  recoverInterruptedTurnsMessage: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("Recover and continue")),
  ),
  /** Fork: the message `recoverInterruptedTurns` sends to a delegated child thread. */
  recoverInterruptedTurnsSubagentMessage: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(
      Effect.succeed("Recover and continue. Your parent thread was also restarted."),
    ),
  ),
  /**
   * Fork: a server that runs as the background service installs each newer
   * fork release when no agent turn runs. See docs/fork.md "Server updates".
   */
  forkAutoUpdate: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Scripts available in every project of this environment. They run where a
   * project script runs for the thread: its worktree, else the project root.
   * They live next to project scripts because both run on this host.
   */
  globalScripts: Schema.Array(ProjectScript).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /**
   * Pinned script ids in button order. Stored on the server next to the
   * scripts they point at, so every client of this environment shows the
   * same pins and project ids stay environment-local.
   */
  pinnedGlobalScriptIds: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  pinnedProjectScriptIds: Schema.Record(ProjectId, Schema.Array(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  agentSessionImportWindowDays: AgentSessionImportWindowDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_SESSION_IMPORT_WINDOW_DAYS)),
  ),
  agentSessionImportMaxMessages: AgentSessionImportMaxMessages.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_SESSION_IMPORT_MAX_MESSAGES)),
  ),
  pullRequestWatchRemarkFilter: PullRequestWatchRemarkFilter.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /**
   * Fork: a checkout's repository is its `origin` remote before its `upstream` remote. A fork
   * checkout then lists, reads and watches the pull requests of the fork, not of upstream.
   */
  preferOriginRemote: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Fork: machine map connection. See `MachineMapSettings`. */
  machineMap: MachineMapSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /** Fork: how a Cloudflare Access sign-in of a browser meets the clients of the map. See `ClientAccessMode`. */
  clientAccess: ClientAccessMode.pipe(Schema.withDecodingDefault(Effect.succeed("off"))),
  /** Fork: user-built thread card layouts. See `ThreadCardLayouts`. */
  threadCardLayouts: ThreadCardLayouts.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /**
   * Fork: sidebar thread groups and their drag assignments. The machine map syncs the value: a
   * change from the sidebar becomes its shared value (MM-411). Clients show the groups while the
   * client setting `sidebarGroupsEnabled` is on.
   */
  sidebarGroups: SidebarGroups.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
};

export const ForkServerSettingsPatchFields = {
  worktreePathTemplate: Schema.optionalKey(TrimmedString),
  recoverInterruptedTurns: Schema.optionalKey(Schema.Boolean),
  recoverInterruptedTurnsMessage: Schema.optionalKey(TrimmedNonEmptyString),
  recoverInterruptedTurnsSubagentMessage: Schema.optionalKey(TrimmedNonEmptyString),
  forkAutoUpdate: Schema.optionalKey(Schema.Boolean),
  globalScripts: Schema.optionalKey(Schema.Array(ProjectScript)),
  pinnedGlobalScriptIds: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** Per-project entry replacement: each entry replaces that project's pins and `null` removes them. */
  pinnedProjectScriptIds: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Array(TrimmedNonEmptyString))),
  ),
  agentSessionImportWindowDays: Schema.optionalKey(AgentSessionImportWindowDays),
  agentSessionImportMaxMessages: Schema.optionalKey(AgentSessionImportMaxMessages),
  preferOriginRemote: Schema.optionalKey(Schema.Boolean),
  /** Replaces the saved groups whole: a merge would keep deleted groups and assignments. */
  sidebarGroups: Schema.optionalKey(SidebarGroups),
  /** Per surface: a patched layout replaces the saved one, and `null` restores the built-in card. */
  threadCardLayouts: Schema.optionalKey(
    Schema.Struct({
      desktop: Schema.optionalKey(Schema.NullOr(StoredThreadCardLayout)),
      mobile: Schema.optionalKey(Schema.NullOr(StoredThreadCardLayout)),
    }),
  ),
  clientAccess: Schema.optionalKey(ClientAccessMode),
  /** Merges per field: a patched field replaces the saved one. */
  machineMap: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      portalUrl: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
  /** Merges per field: a patched field replaces the saved one. */
  pullRequestWatchRemarkFilter: Schema.optionalKey(
    Schema.Struct({
      authorAssociations: Schema.optionalKey(Schema.Array(PullRequestAuthorAssociation)),
      authorLogins: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
      agentMarker: Schema.optionalKey(TrimmedString),
    }),
  ),
};
