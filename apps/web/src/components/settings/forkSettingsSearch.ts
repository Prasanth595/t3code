/**
 * Fork settings search items. `settingsSearch.ts` spreads each group at the place of its rows, so
 * search results keep their order and the upstream array keeps one line per group.
 */
import type { SettingsSearchItem, SettingsSearchScope } from "./settingsSearch";

export type ForkSettingsPath = "/settings/machines" | "/settings/fork";

export const SECTION_LABELS: Readonly<Record<ForkSettingsPath, string>> = {
  "/settings/machines": "Machines",
  "/settings/fork": "Fork",
};

export const CATEGORY_SCOPES: Readonly<Record<ForkSettingsPath, SettingsSearchScope | null>> = {
  "/settings/machines": null,
  // Each row of the Fork page keeps the scope of its usual place.
  "/settings/fork": null,
};

export const WORKTREE_PATH_TEMPLATE_ITEMS = [
  {
    id: "storage-worktree-path-template",
    title: "Worktree path template",
    to: "/settings/storage",
    scope: "environment-defaults",
    searchTerms: ["worktree path template folder branch bare container repository sibling"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const APPEARANCE_ITEMS = [
  {
    id: "thread-card-layout",
    title: "Custom card layout",
    to: "/settings/appearance",
    scope: "environment-defaults",
    searchTerms: ["thread card sidebar compact density rows builder layout mobile branch"],
  },
  {
    id: "thread-link-chips",
    title: "Thread link chips",
    to: "/settings/appearance",
    searchTerms: ["thread link chip chat message url open app machine environment"],
    environmentOnly: true,
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const GLOBAL_SCRIPTS_ITEMS = [
  {
    id: "global-scripts",
    title: "Global scripts",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["scripts commands every project pin pinned buttons background overlay preview"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const NOTIFICATION_ITEMS = [
  {
    id: "installed-app",
    title: "Installed app",
    to: "/settings/general",
    searchTerms: ["install pwa home screen offline service worker badge phone android iphone"],
    webOnly: true,
  },
  {
    id: "web-push",
    title: "Web Push",
    to: "/settings/general",
    searchTerms: ["web push notification phone android closed app background"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const RECOVER_INTERRUPTED_TURNS_ITEMS = [
  {
    id: "recover-interrupted-turns",
    title: "Recover interrupted agents",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: [
      "recover continue resume restart crash update quit interrupted agent subagent message background",
    ],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const AGENT_SESSION_IMPORT_ITEMS = [
  {
    id: "agent-session-import-window",
    title: "Session import window",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["import claude code codex history days recent sessions"],
  },
  {
    id: "agent-session-import-max-messages",
    title: "Imported messages per session",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["import claude code codex history message limit transcript"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const BEHAVIOR_ITEMS = [
  {
    id: "terminal-close-confirmation",
    title: "Terminal close confirmation",
    to: "/settings/general",
    searchTerms: ["ask before terminal close stop process"],
  },
  {
    id: "terminal-app-shortcuts-first",
    title: "App shortcuts in terminal",
    to: "/settings/general",
    searchTerms: ["terminal keybindings keyboard shortcuts priority shell focus"],
  },
  {
    id: "repository-owner-filters",
    title: "Repository owner filters",
    to: "/settings/general",
    searchTerms: [
      "github organization org owner account filter hide exclude pull requests sidebar work personal",
    ],
  },
  {
    id: "snooze-quick-options",
    title: "Snooze quick options",
    to: "/settings/general",
    searchTerms: ["snooze menu presets choices later tonight tomorrow next week remind wake"],
  },
  {
    id: "sidebar-groups",
    title: "Sidebar groups",
    to: "/settings/general",
    searchTerms: ["tabs folders groups organize threads drag rules monitors views sidebar"],
  },
  {
    id: "sidebar-group-single-thread",
    title: "Single-thread tabs",
    to: "/settings/general",
    searchTerms: ["sidebar group tab one thread open directly"],
  },
  {
    id: "pull-request-filter-chips",
    title: "Pull request filter chips",
    to: "/settings/general",
    searchTerms: ["active filters chips exclude negative is not pull requests list empty"],
  },
  {
    id: "app-toggle-shortcuts",
    title: "App toggle shortcuts",
    to: "/settings/general",
    searchTerms: ["global hotkey keyboard shortcut show hide toggle window raycast f17"],
    desktopOnly: true,
  },
  {
    id: "background-work-details",
    title: "Background work details",
    to: "/settings/general",
    searchTerms: ["monitor background command agent task output file popover markdown links"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const ABOUT_ITEMS = [
  {
    id: "fork-changelog",
    title: "Fork changelog",
    to: "/settings/general",
    searchTerms: ["changelog release notes versions upstream fork sync workflow"],
  },
  {
    id: "check-newer-before-update-install",
    title: "Check for a newer update before install",
    to: "/settings/general",
    searchTerms: ["desktop update install newer release download restart"],
  },
  {
    id: "fork-auto-update",
    title: "Server auto-update",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["fork release install update idle background service headless server automatic"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const PULL_REQUEST_ITEMS = [
  {
    id: "prefer-origin-remote",
    title: "Pull requests from origin",
    to: "/settings/source-control",
    searchTerms: ["fork origin upstream remote repository pull request pr list"],
    environmentOnly: true,
  },
  {
    id: "pull-request-watch-roles",
    title: "Roles that wake agents",
    to: "/settings/source-control",
    searchTerms: [
      "pull request pr watch remark comment review wake agent owner member collaborator author association role",
    ],
    environmentOnly: true,
  },
  {
    id: "pull-request-watch-logins",
    title: "Logins that wake agents",
    to: "/settings/source-control",
    searchTerms: ["pull request pr watch remark comment review wake agent github user author"],
    environmentOnly: true,
  },
  {
    id: "pull-request-watch-agent-marker",
    title: "Agent remark marker",
    to: "/settings/source-control",
    searchTerms: ["pull request pr watch remark comment wake agent bot skip ignore html comment"],
    environmentOnly: true,
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const TUNNEL_PAIRING_ITEMS = [
  {
    id: "tunnel-pairing",
    title: "Allow pairing through a tunnel",
    to: "/settings/connections",
    searchTerms: [
      "tunnel cloudflared pairing loopback trusted browser origins cookies cloudflare access login team domain audience aud emails service token",
    ],
    desktopOnly: true,
    localBackendManagementOnly: true,
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

// Fork: machine map (apps/machine-map/SPEC.md MM-203).
export const MACHINE_MAP_ITEMS = [
  {
    id: "machine-map",
    title: "Machine map",
    to: "/settings/machines",
    searchTerms: ["portal join code leave connection status cloudflare access token tunnel"],
  },
  {
    id: "machine-map-client-access",
    title: "Client access",
    to: "/settings/machines",
    searchTerms: ["browser clients enforce observe approval cloudflare access lockout way back in"],
  },
  {
    id: "machine-map-reachable",
    title: "Machines this machine can use",
    to: "/settings/machines",
    searchTerms: ["reachable peers arrows levels read standard admin agent tools open"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
