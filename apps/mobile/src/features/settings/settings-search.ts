import type { AppSymbolName } from "../../components/ui/AppSymbol";
import type {
  SettingsLegalDocumentTarget,
  SettingsSheetTarget,
} from "./components/settings-sheet-targets";

interface SettingsSearchItem {
  readonly title: string;
  readonly section: string;
  readonly icon: AppSymbolName;
  readonly target: SettingsSheetTarget | SettingsLegalDocumentTarget | "SettingsAuth";
  readonly keywords: string;
  readonly iosOnly?: boolean;
  readonly cloudOnly?: boolean;
  readonly environmentOnly?: boolean;
  readonly projectOnly?: boolean;
}

const SETTINGS_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    title: "T3 Account",
    section: "Connections",
    icon: "person.crop.circle",
    target: "SettingsAuth",
    keywords: "sign in sign out login email subscription cloud connect",
    cloudOnly: true,
  },
  {
    title: "Environments",
    section: "Connections",
    icon: "desktopcomputer",
    target: "SettingsEnvironments",
    keywords:
      "server remote host add pair pairing code qr connection tunnel t3 connect github sharing",
  },
  {
    title: "Notifications",
    section: "Connections",
    icon: "bell.badge",
    target: "SettingsNotifications",
    keywords:
      "device push agent activity live activities ongoing activity live updates alerts permission",
    cloudOnly: true,
  },
  {
    title: "Appearance",
    section: "Interface",
    icon: "paintbrush",
    target: "SettingsAppearance",
    keywords:
      "theme light dark system colors text size custom font size terminal code diffs word break wrap",
  },
  {
    title: "Keyboard",
    section: "Interface",
    icon: "keyboard",
    target: "SettingsKeyboard",
    keywords: "return key enter send message newline new line",
    iosOnly: true,
  },
  {
    title: "Microphone",
    section: "Interface",
    icon: "mic",
    target: "SettingsMicrophone",
    keywords: "voice dictation audio input recording access permission preferred order",
    iosOnly: true,
  },
  {
    title: "Scheduled tasks",
    section: "Automations",
    icon: "clock",
    target: "SettingsScheduledTasks",
    keywords: "schedule recurring cron interval background jobs automate",
  },
  {
    title: "Project overview",
    section: "Projects & threads",
    icon: "folder",
    target: "SettingsProjectOverview",
    keywords: "checkouts workspace repository path branch",
    projectOnly: true,
  },
  {
    title: "Organization",
    section: "Projects & threads",
    icon: "folder",
    target: "SettingsOrganization",
    keywords: "project grouping group repository path keep separate monorepo workspace sidebar",
  },
  {
    title: "Thread behavior",
    section: "Projects & threads",
    icon: "text.bubble",
    target: "SettingsThreads",
    keywords:
      "usage limits auto resume snooze limited auto settle merged inactive across environments working section beta legacy plan mode",
  },
  {
    title: "Follow-ups",
    section: "Projects & threads",
    icon: "arrow.turn.left.up",
    target: "SettingsFollowUp",
    keywords: "followups follow ups agent running queue interrupt steer message send",
  },
  {
    title: "Archived threads",
    section: "Projects & threads",
    icon: "archivebox",
    target: "SettingsArchive",
    keywords: "archive restore reopen history",
  },
  {
    title: "Provider accounts",
    section: "Server settings",
    icon: "person.crop.circle",
    target: "SettingsProviderAccounts",
    keywords:
      "agents codex claude cursor grok opencode antigravity sign in sign out login authentication api key",
    environmentOnly: true,
  },
  {
    title: "New threads",
    section: "Server settings",
    icon: "text.bubble",
    target: "SettingsEnvironmentNewThreads",
    keywords:
      "default workspace current checkout new worktree submodules recursive permissions runtime full access approval",
    environmentOnly: true,
  },
  {
    title: "Source control",
    section: "Server settings",
    icon: "arrow.triangle.branch",
    target: "SettingsEnvironmentSourceControl",
    keywords:
      "git github pull requests remove agent credits merging co authors automatically pull default branch worktrees start from origin branch naming prefix instructions semantic",
    environmentOnly: true,
  },
  {
    title: "Agent behavior",
    section: "Server settings",
    icon: "text.alignleft",
    target: "SettingsEnvironmentAgentBehavior",
    keywords: "response streaming after turn finished paragraphs preview browser access",
    environmentOnly: true,
  },
  {
    title: "Maintenance",
    section: "Server settings",
    icon: "arrow.clockwise",
    target: "SettingsEnvironmentMaintenance",
    keywords:
      "manage environments check provider updates continue threads after restart server update",
    environmentOnly: true,
  },
  {
    title: "Usage",
    section: "App",
    icon: "chart.bar.xaxis",
    target: "SettingsUsage",
    keywords: "tokens cost limits quota accounts analytics spending",
  },
  {
    title: "About T3 Code",
    section: "App",
    icon: "info.circle",
    target: "SettingsAbout",
    keywords: "version build app updates release channel",
  },
  {
    title: "Client Storage",
    section: "About T3 Code",
    icon: "internaldrive",
    target: "SettingsClientStorage",
    keywords: "environment caches cache clear local data disk space",
  },
  {
    title: "Diagnostics",
    section: "About T3 Code",
    icon: "stethoscope",
    target: "SettingsDiagnostics",
    keywords: "debug logs logging errors troubleshooting telemetry export",
  },
  {
    title: "Open source licenses",
    section: "About T3 Code",
    icon: "doc.on.doc",
    target: "SettingsOpenSourceLicenses",
    keywords: "third party libraries dependencies notices legal",
  },
  {
    title: "Legal",
    section: "About T3 Code",
    icon: "doc.text",
    target: "SettingsLegal",
    keywords: "privacy policy terms service",
  },
];

function normalizeSearchText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function searchSettings(
  query: string,
  availability: {
    readonly platform: string;
    readonly hasCloud: boolean;
    readonly hasEnvironment: boolean;
    readonly hasProject: boolean;
  },
) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];
  const tokens = normalizedQuery.split(" ");

  return SETTINGS_SEARCH_ITEMS.flatMap((item) => {
    if (item.iosOnly && availability.platform !== "ios") return [];
    if (item.cloudOnly && !availability.hasCloud) return [];
    if (item.environmentOnly && !availability.hasEnvironment) return [];
    if (item.projectOnly && !availability.hasProject) return [];

    const title = normalizeSearchText(item.title);
    const text = normalizeSearchText(`${item.title} ${item.section} ${item.keywords}`);
    if (!tokens.every((token) => text.includes(token))) return [];
    const rank =
      title === normalizedQuery
        ? 3
        : title.startsWith(normalizedQuery)
          ? 2
          : title.includes(normalizedQuery)
            ? 1
            : 0;
    return [{ item, rank }];
  })
    .sort((left, right) => right.rank - left.rank)
    .map(({ item }) => item);
}
