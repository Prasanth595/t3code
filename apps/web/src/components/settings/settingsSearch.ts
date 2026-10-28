import { HOSTED_APP_CHANNEL } from "~/branding";
import { isElectron } from "~/env";
import { isMacPlatform, isWindowsPlatform, normalizeSearchText } from "~/lib/utils";
import { STATIC_KEYBINDING_COMMANDS, type KeybindingCommand } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  sourceControlClients,
  type SourceControlDefinition,
} from "@t3tools/client-runtime/source-control-clients";
import { DEFAULT_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { commandLabel } from "./KeybindingsSettings.logic";
import {
  validateSettingsScopeSearch,
  type ResolvedSettingsScope,
  type SettingsScopeSearch,
} from "./settingsScope";

export type SettingsPath =
  | "/settings/projects"
  | "/settings/general"
  | "/settings/diagnostics"
  | "/settings/appearance"
  | "/settings/keybindings"
  | "/settings/snap-shot"
  | "/settings/providers"
  | "/settings/integrations"
  | "/settings/scheduled-tasks"
  | "/settings/source-control"
  | "/settings/storage"
  | "/settings/connections"
  | "/settings/beta"
  | "/settings/archived";

export type SettingsSearchScope =
  | "environment"
  | "environment-defaults"
  | "project-defaults"
  | "project"
  | "checkout"
  | "connections";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
  readonly searchTerms?: ReadonlyArray<string>;
  readonly scope?: SettingsSearchScope;
  readonly desktopOnly?: boolean;
  readonly macOnly?: boolean;
  readonly windowsOnly?: boolean;
  readonly releaseChannelOnly?: boolean;
  readonly cloudOnly?: boolean;
  readonly environmentOnly?: boolean;
  readonly providerSettingsOnly?: boolean;
  readonly macProviderSettingsOnly?: boolean;
  readonly localBackendManagementOnly?: boolean;
  readonly localEnvironmentOnly?: boolean;
  readonly wslAvailableOnly?: boolean;
  readonly managedTunnelOnly?: boolean;
  readonly secondary?: boolean;
  readonly requiresThreadAutoSettlement?: boolean;
}

export interface SettingsSearchAvailability {
  readonly localEnvironmentDisabled?: boolean;
  readonly hasCloudPublicConfig: boolean;
  readonly hasEnvironment: boolean;
  readonly hasProviderSettingsEnvironment: boolean;
  readonly hasMacProviderSettingsEnvironment: boolean;
  readonly canManageLocalBackend: boolean;
  readonly isWslSettingsRowVisible: boolean;
  readonly hasThreadAutoSettlement: boolean;
  readonly managedTunnelActive?: boolean;
}

export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/diagnostics": "Diagnosticare",
  "/settings/projects": "Proiect",
  "/settings/general": "General",
  "/settings/appearance": "Aspect",
  "/settings/keybindings": "Scurtături",
  "/settings/snap-shot": "Capturi",
  "/settings/providers": "Furnizori",
  "/settings/integrations": "Integrări",
  "/settings/scheduled-tasks": "Sarcini programate",
  "/settings/source-control": "Controlul versiunilor",
  "/settings/storage": "Stocare",
  "/settings/connections": "Conexiuni",
  "/settings/beta": "Beta",
  "/settings/archived": "Arhivă",
};

export function keybindingSearchAnchorId<Command extends KeybindingCommand>(command: Command) {
  return `keybinding-${command}` as const;
}

const KEYBINDING_SEARCH_ITEMS = STATIC_KEYBINDING_COMMANDS.toSorted((left, right) =>
  commandLabel(left).localeCompare(commandLabel(right)),
).map((command) => {
  const defaultKeys = DEFAULT_KEYBINDINGS.filter((binding) => binding.command === command).map(
    (binding) => binding.key,
  );
  return {
    id: keybindingSearchAnchorId(command),
    title: commandLabel(command),
    to: "/settings/keybindings" as const,
    searchTerms: [command, ...defaultKeys],
    secondary: true,
    ...(defaultKeys.length === 0 ? { targetId: "keybindings" } : {}),
  };
});

export function sourceControlHostSettingsSearchId(kind: string) {
  return `source-control-host-${kind}` as const;
}

/** Each host's own settings: its accounts and token, or the fields of its settings form. */
export function sourceControlHostSearchItems(
  definitions: ReadonlyArray<SourceControlDefinition>,
): ReadonlyArray<
  SettingsSearchItem & { readonly id: ReturnType<typeof sourceControlHostSettingsSearchId> }
> {
  return definitions.flatMap((definition) => {
    if (!definition.settings) return [];
    const names = [definition.label, ...(definition.searchKeywords ?? [])].join(" ");
    const { credentials } = definition;
    return [
      {
        id: sourceControlHostSettingsSearchId(definition.kind),
        title: credentials
          ? `${definition.label} accounts and token`
          : `${definition.label} credentials`,
        to: "/settings/source-control" as const,
        searchTerms: [
          credentials
            ? `${names} ${credentials.cliName} account login user host switch multiple accounts disable sign in token personal access token pat api key credential`
            : `${names} ${Object.keys(definition.settings.fields).join(" ")} token credentials sign in`,
        ],
        environmentOnly: true,
        scope: "environment-defaults" as const,
      },
    ];
  });
}

/** For settings that apply to every host. */
const SOURCE_CONTROL_HOST_LABELS = sourceControlClients.definitions
  .map((definition) => definition.label)
  .join(" ");
const SOURCE_CONTROL_HOST_TERMS = sourceControlClients.definitions
  .flatMap((definition) => [definition.label, ...(definition.searchKeywords ?? [])])
  .join(" ");

export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "storage-worktree-keep-when",
    targetId: "storage-worktrees",
    title: "Păstrează worktree-urile cu modificări locale",
    to: "/settings/storage",
    scope: "project-defaults",
    searchTerms: [
      "any local files uncommitted changes edited tracked files ignored env build output cleanup",
    ],
  },
  {
    id: "storage-delete-now",
    title: "Șterge acum",
    to: "/settings/storage",
    scope: "environment-defaults",
    searchTerms: ["storage cleanup run now results report removed kept failed"],
  },
  {
    id: "storage-worktrees",
    title: "Curățare worktree-uri",
    to: "/settings/storage",
    scope: "project-defaults",
    searchTerms: [
      "disk storage delete deleted archived threads old inactive merged unchanged worktrees retention days project inherit off custom",
    ],
  },
  {
    id: "storage-worktrees-location",
    title: "Locația worktree-urilor",
    to: "/settings/storage",
    scope: "environment-defaults",
    searchTerms: ["worktree location folder directory path drive external disk"],
  },
  {
    id: "storage-artifacts",
    title: "Artefacte și jurnale",
    to: "/settings/storage",
    scope: "environment-defaults",
    searchTerms: ["disk storage browser screenshots captures rotated logs cleanup retention"],
  },
  {
    id: "project-defaults",
    title: "Valori implicite și excepții pentru proiect",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["model workspace environments projects inheritance checkout"],
  },
  {
    id: "project-overview",
    title: "Prezentare proiect",
    to: "/settings/projects",
    searchTerms: ["name icon emoji image checkout remove delete"],
  },
  {
    id: "default-model",
    title: "Model implicit",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["new thread project provider reasoning effort"],
  },
  {
    id: "default-permissions",
    title: "Permisiuni",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: [
      "new thread default runtime mode supervised approvals auto accept edits full access",
    ],
  },
  {
    id: "color-scheme",
    title: "Schemă de culori",
    to: "/settings/appearance",
    searchTerms: ["appearance light dark system mode"],
    targetId: "appearance",
  },
  {
    id: "theme",
    title: "Teme",
    to: "/settings/appearance",
    searchTerms: ["appearance colors palette custom import"],
    targetId: "appearance",
  },
  {
    // Prefixed because the slider control already owns the `appearance-contrast` id.
    id: "setting-appearance-contrast",
    title: "Contrast",
    to: "/settings/appearance",
    searchTerms: ["colors borders interface"],
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    title: "Opacitate sticlă",
    to: "/settings/appearance",
    searchTerms: ["transparent transparency solid menus dialogs composer"],
  },
  {
    id: "diff-color-scheme",
    title: "Culori diff",
    to: "/settings/appearance",
    searchTerms: ["red green blue orange additions deletions changes counts palette colorblind"],
  },
  {
    id: "chat-width",
    title: "Lățimea conversației",
    to: "/settings/appearance",
    searchTerms: ["wide full width column layout messages composer monitor"],
  },
  {
    id: "math-rendering",
    title: "Afișează formule matematice",
    to: "/settings/appearance",
    searchTerms: ["latex tex katex equations formulas markdown"],
  },
  {
    id: "panel-animations",
    title: "Animații panouri",
    to: "/settings/appearance",
  },
  {
    id: "environment-identification",
    title: "Identificarea mediului",
    to: "/settings/appearance",
    searchTerms: ["dev nightly artwork pill label hide none"],
    targetId: "appearance-interface",
  },
  {
    id: "interface-font",
    title: "Font interfață",
    to: "/settings/appearance",
    searchTerms: ["typography family size system sans"],
  },
  {
    id: "prompt-font",
    title: "Font prompt",
    to: "/settings/appearance",
    searchTerms: ["typography family size composer input"],
  },
  {
    id: "code-font",
    title: "Font cod",
    to: "/settings/appearance",
    searchTerms: ["typography family size monospace code blocks diffs file previews"],
  },
  {
    id: "terminal-font",
    title: "Font terminal",
    to: "/settings/appearance",
    searchTerms: ["typography family size monospace output"],
  },
  {
    id: "font-smoothing",
    title: "Netezire font",
    to: "/settings/appearance",
    searchTerms: ["typography text grayscale anti aliasing macos thin"],
    macOnly: true,
  },
  {
    id: "word-wrap",
    title: "Încadrare text",
    to: "/settings/appearance",
    searchTerms: ["long lines code blocks tables diffs file previews"],
  },
  {
    id: "composer-context",
    title: "Contextul editorului",
    to: "/settings/appearance",
  },
  {
    id: "project-grouping",
    title: "Gruparea proiectelor",
    to: "/settings/general",
    searchTerms: ["combine matching repositories environments sidebar"],
  },
  {
    id: "project-order",
    title: "Ordinea proiectelor",
    to: "/settings/general",
    searchTerms: ["sort projects sidebar manual created recent"],
  },
  {
    id: "snooze-limited-threads",
    title: "Amână până se resetează limitele",
    to: "/settings/general",
    searchTerms: ["usage quota rate limit reset wake recover continue"],
  },
  {
    id: "auto-resume-limited-threads",
    title: "Reia după limitele de utilizare",
    to: "/settings/general",
    searchTerms: ["usage quota rate limit reset recover continue"],
  },
  {
    id: "working-shelf",
    title: "Secțiunea În lucru",
    to: "/settings/beta",
    searchTerms: ["beta hide fold running monitoring threads inbox sidebar shelf"],
  },
  {
    id: "guest-links",
    title: "Link-uri pentru invitați",
    to: "/settings/beta",
    scope: "environment",
    searchTerms: ["beta share guest invite link teammate watch t3 connect tunnel"],
  },
  {
    id: "auto-settle-inactive-threads",
    title: "Finalizează automat conversațiile inactive",
    to: "/settings/general",
    searchTerms: ["sidebar inactivity days no activity automatically"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "auto-settle-merged-threads",
    title: "Finalizează automat conversațiile cu merge",
    to: "/settings/general",
    searchTerms: ["pull request merge closed automatically sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "days-before-auto-settle",
    title: "Zile de inactivitate până la finalizarea automată",
    to: "/settings/general",
    targetId: "auto-settle-inactive-threads",
    searchTerms: ["thread timeout activity sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "thread-notifications",
    title: "Notificări conversații",
    to: "/settings/general",
    searchTerms: ["notification sound alert completion input approval desktop"],
  },
  {
    id: "in-app-notifications",
    title: "Notificări în aplicație",
    to: "/settings/general",
    searchTerms: ["notification toast popup completion input approval failure"],
  },
  {
    id: "time-format",
    title: "Format oră",
    to: "/settings/general",
    searchTerms: ["timestamp clock locale system browser os 12 hour 24 hour"],
  },
  {
    id: "response-streaming",
    title: "Afișarea răspunsului",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["output token paragraph buffered wait turn legacy"],
  },
  {
    id: "hide-whitespace-changes",
    title: "Ascunde modificările de spațiere",
    to: "/settings/general",
    searchTerms: ["diff ignore spaces edits default"],
  },
  {
    id: "default-diff-file-state",
    title: "Stare implicită fișiere diff",
    to: "/settings/general",
    searchTerms: ["collapsed expanded collapse expand files pull request pr code tab"],
  },
  {
    id: "diff-layout",
    title: "Aranjare diff",
    to: "/settings/general",
    searchTerms: ["stacked split side by side unified inline view"],
  },
  {
    id: "proactive-panels",
    title: "Panouri proactive",
    to: "/settings/general",
    searchTerms: ["automatically open diff pull request pr right panel agent completion"],
  },
  {
    id: "skills-in-slash-menu",
    title: "Arată abilitățile în meniul /",
    to: "/settings/general",
    searchTerms: ["command menu dollar $ slash /"],
  },
  {
    id: "composer-rich-text",
    title: "Editor cu text formatat",
    to: "/settings/general",
    searchTerms: ["composer rich text tiptap bold italic markdown styled wysiwyg"],
  },
  {
    id: "composer-collapse",
    title: "Restrânge editorul la derulare",
    to: "/settings/general",
    searchTerms: ["composer rest resting scroll wheel conversation timeline shrink minimize"],
  },
  {
    id: "send-shortcut",
    title: "Scurtătură de trimitere",
    to: "/settings/general",
    searchTerms: ["enter return command ctrl multiline prompt new line composer"],
  },
  {
    id: "follow-up-behavior",
    title: "Comportament mesaje ulterioare",
    to: "/settings/general",
    searchTerms: ["queue steer running turn send default behavior composer"],
  },
  {
    id: "provider-update-checks",
    title: "Verificare actualizări furnizori",
    to: "/settings/general",
    searchTerms: ["installed cli versions newer available codex claude cursor grok opencode"],
    scope: "environment-defaults",
  },
  {
    id: "continue-threads-after-server-update",
    title: "Continuă conversațiile după repornire",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: [
      "resume running active interrupted work restart reboot machine crash desktop update automatically",
    ],
  },
  {
    id: "background-activity",
    title: "Activitate în fundal",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: [
      "balanced performance battery saver advanced git fetch provider health refresh host power monitor idle policy",
    ],
  },
  {
    id: "new-threads",
    title: "Conversații noi",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["default workspace mode draft local worktree"],
  },
  {
    id: "worktree-submodules",
    title: "Submodule",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["git submodule init recursive top-level none worktree t3.json"],
  },
  {
    id: "start-from-origin",
    title: "Pornește din remote",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["new worktrees start remote origin latest fetched branch local"],
  },
  {
    id: "add-project-starts-in",
    title: "Adăugarea de proiecte pornește din",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["base directory folder browser path home"],
  },
  {
    id: "unpin-confirmation",
    title: "Confirmare defixare",
    to: "/settings/general",
    searchTerms: ["ask before thread pinned section"],
  },
  {
    id: "archive-confirmation",
    title: "Confirmare arhivare",
    to: "/settings/general",
    searchTerms: ["ask before thread second click inline action"],
  },
  {
    id: "delete-confirmation",
    title: "Confirmare ștergere",
    to: "/settings/general",
    searchTerms: ["ask before thread chat history"],
  },
  {
    id: "quit-confirmation",
    title: "Scurtătură de închidere",
    to: "/settings/general",
    searchTerms: ["confirmation desktop app exit direct hold double click press twice"],
    desktopOnly: true,
  },
  {
    id: "text-generation-model",
    title: "Model de generare text",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["generated thread titles source control content default provider"],
  },
  {
    id: "thread-title-instructions",
    title: "Instrucțiuni pentru titluri",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["generated thread titles prompt custom style naming rename regenerate"],
  },
  {
    id: "app-version",
    title: "Versiune",
    to: "/settings/general",
    searchTerms: ["about check for updates download install upgrade release"],
  },
  {
    id: "update-track",
    title: "Canal de actualizare",
    to: "/settings/general",
    searchTerms: ["release channel stable latest nightly prerelease"],
    releaseChannelOnly: true,
  },
  {
    id: "cli-command",
    title: "Comanda t3",
    to: "/settings/general",
    searchTerms: ["cli terminal shell path install command line"],
    desktopOnly: true,
  },
  {
    id: "mobile-app",
    title: "Aplicația mobilă",
    to: "/settings/general",
    searchTerms: ["phone tablet iPhone iPad iOS Android App Store Google Play QR"],
  },
  {
    id: "privacy-policy",
    title: "Politica de confidențialitate",
    to: "/settings/general",
    searchTerms: ["telemetry analytics usage data tracking legal opt out"],
  },
  {
    id: "telemetry-export",
    title: "Export OpenTelemetry",
    to: "/settings/diagnostics",
    targetId: "telemetry-export",
    scope: "environment",
    searchTerms: ["OTel OTLP telemetry export endpoints logs traces metrics Grafana"],
  },
  {
    id: "diagnostics",
    title: "Diagnosticare",
    to: "/settings/general",
    searchTerms: ["logs traces processes resource history failures spans cpu memory"],
  },
  {
    id: "open-source-licenses",
    title: "Licențe open source",
    to: "/settings/general",
  },
  {
    id: "legacy-plan-mode",
    title: "Mod plan (vechi)",
    to: "/settings/general",
    searchTerms: ["build plan composer old"],
  },
  {
    id: "legacy-context-window-indicator",
    title: "Indicator fereastră de context (vechi)",
    to: "/settings/general",
    searchTerms: ["composer meter usage tokens circle old"],
  },
  {
    id: "legacy-sidebar",
    title: "Bară laterală (veche)",
    to: "/settings/general",
    searchTerms: ["project thread tree old flat list"],
  },
  {
    id: "keybindings",
    title: "Scurtături de tastatură",
    to: "/settings/keybindings",
    searchTerms: ["keyboard shortcuts hotkeys commands bindings json"],
  },
  ...KEYBINDING_SEARCH_ITEMS,
  {
    id: "snap-shot-enabled",
    title: "Capturi",
    searchTerms: ["window capture screenshot"],
    to: "/settings/snap-shot",
  },
  {
    id: "snap-shot-accessibility",
    title: "Include textul aplicației",
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
    searchTerms: [
      "capture accessibility data text UI structure elements privacy omit agent context",
    ],
  },
  {
    id: "snap-shot-shortcut",
    title: "Scurtătură captură",
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "snap-shot-sound",
    title: "Sunet la captură",
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "snap-shot-flash",
    title: "Bliț la captură",
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "snap-shot-animations",
    title: "Animații la captură",
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "providers",
    title: "Furnizori",
    to: "/settings/providers",
    searchTerms: [
      "agents cli codex claude cursor grok opencode antigravity google sign in sign out install subscription instances authentication api key models configuration binary path config directory endpoint arguments environment variables display name accent color custom favorite hidden auto compact",
    ],
  },
  {
    id: "usage-providers",
    title: "Furnizori de utilizare",
    to: "/settings/providers",
    searchTerms: [
      "usage sources CLIProxyAPI CLI proxy hub quota subscription limits management key add remove",
    ],
    providerSettingsOnly: true,
  },
  {
    id: "cursor-keychain-usage",
    title: "Utilizare cont Cursor",
    to: "/settings/providers",
    searchTerms: ["cursor macOS keychain usage tokens cost limits permission"],
    providerSettingsOnly: true,
    macProviderSettingsOnly: true,
  },
  {
    id: "provider-health-check-interval",
    title: "Interval verificare stare",
    to: "/settings/providers",
    searchTerms: ["refresh availability versions auth state models background probes seconds off"],
    providerSettingsOnly: true,
  },
  {
    id: "agent-browser-access",
    title: "Acces agent la browser",
    to: "/settings/integrations",
    scope: "project-defaults",
    searchTerms: ["allow disable enable open drive preview tools sessions project override"],
  },
  {
    id: "device-hosts",
    title: "Gazde dispozitive",
    to: "/settings/integrations",
    searchTerms: ["ssh remote simulator emulator ios android mac mini identity key connection"],
  },
  {
    id: "agent-device-access",
    title: "Acces agent la dispozitive",
    to: "/settings/integrations",
    targetId: "devices",
    searchTerms: ["allow simulator emulator ios android drive tools sessions"],
  },
  {
    id: "device-hub",
    title: "Hub dispozitive",
    to: "/settings/integrations",
    targetId: "devices",
    searchTerms: ["simulator emulator ios android install start"],
  },
  {
    id: "device-platform-support",
    title: "Suport simulator",
    to: "/settings/integrations",
    targetId: "devices",
    searchTerms: ["xcode android studio sdk avd runtime"],
  },
  {
    id: "browser-profiles",
    title: "Profiluri browser",
    to: "/settings/integrations",
    targetId: "browser",
  },
  {
    id: "browser-default-profile",
    title: "Profil implicit browser",
    to: "/settings/integrations",
    targetId: "browser-profiles",
  },
  {
    id: "browser-default-viewport",
    title: "Dimensiune implicită browser",
    to: "/settings/integrations",
    searchTerms: ["preview size width height device desktop mobile rotate"],
  },
  {
    id: "browser-default-zoom",
    title: "Zoom implicit browser",
    to: "/settings/integrations",
    searchTerms: ["preview page scale tabs percent"],
  },
  {
    id: "browser-default-appearance",
    title: "Aspect implicit browser",
    to: "/settings/integrations",
    searchTerms: ["preview color scheme light dark system os"],
  },
  {
    id: "browser-recording-frame-rate",
    title: "Cadre pe secundă la înregistrare",
    to: "/settings/integrations",
  },
  {
    id: "browser-recording-key-presses",
    title: "Arată tastele apăsate în înregistrări",
    to: "/settings/integrations",
    searchTerms: ["browser preview keyboard shortcuts keystrokes overlay capture"],
  },
  {
    id: "browser-recording-mouse-presses",
    title: "Arată clicurile în înregistrări",
    to: "/settings/integrations",
    searchTerms: ["browser preview clicks buttons drag overlay capture"],
  },
  {
    id: "browser-link-target",
    title: "Deschide link-urile în",
    to: "/settings/integrations",
    searchTerms: ["links default browser in-app browser external open"],
  },
  {
    id: "browser-search-engine",
    title: "Motor de căutare",
    to: "/settings/integrations",
    searchTerms: ["address bar duckduckgo google bing brave kagi ecosia custom"],
  },
  {
    id: "pull-request-links-open-in-app",
    title: "Deschide pull request-urile în Mira",
    to: "/settings/integrations",
    searchTerms: [
      `pr links ${SOURCE_CONTROL_HOST_LABELS} browser external click default pull request view panel`,
    ],
  },
  {
    id: "browser-auto-show-floating-preview",
    title: "Arată automat previzualizarea plutitoare",
    to: "/settings/integrations",
    searchTerms: ["agent opens browser device simulator pop into view hide"],
  },
  {
    id: "automatic-pull",
    title: "Pull automat",
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: ["auto pull default branch current checkout fast forward upstream"],
  },
  {
    id: "remove-agent-credits-on-merge",
    title: "Elimină creditele agentului la merge",
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: [
      `pull request ${SOURCE_CONTROL_HOST_LABELS} squash co-authored-by attribution claude codex generated`,
    ],
  },
  {
    id: "pull-request-merge-method",
    title: "Metodă implicită de merge",
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: ["pull request merge squash rebase last selected"],
  },
  {
    id: "source-control",
    title: "Controlul versiunilor",
    to: "/settings/source-control",
    scope: "environment-defaults",
    searchTerms: [
      `version control git ${SOURCE_CONTROL_HOST_TERMS} hosting integrations credentials scan server environment`,
    ],
  },
  {
    id: "git-fetch-interval",
    title: "Interval git fetch",
    to: "/settings/source-control",
    searchTerms: [
      "automatic remote branch refresh background credentials security keys seconds off",
    ],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "worktree-branch-naming",
    title: "Denumirea branch-urilor worktree",
    to: "/settings/source-control",
    searchTerms: ["static semantic prefix custom prompt instructions feat fix refactor chore"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  ...sourceControlHostSearchItems(sourceControlClients.definitions),
  {
    id: "source-control-writing-style",
    title: "Stil texte control al versiunilor",
    to: "/settings/source-control",
    searchTerms: [
      "repository conventions conventional commits custom instructions change descriptions request titles",
    ],
    environmentOnly: true,
  },
  {
    id: "follow-change-request-templates",
    title: "Urmează șabloanele de PR",
    to: "/settings/source-control",
    searchTerms: ["repository pr pull request description structure"],
    environmentOnly: true,
  },
  {
    id: "source-control-writer-model",
    title: "Model pentru texte de control al versiunilor",
    to: "/settings/source-control",
    searchTerms: [
      "override generated commit change request pr titles descriptions branch bookmark",
    ],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "review-guides",
    title: "Ghiduri de revizuire (beta)",
    to: "/settings/source-control",
    searchTerms: ["pull request pr guided review guide tour beta experimental"],
    environmentOnly: true,
  },
  {
    id: "review-guide-model",
    title: "Model ghid de revizuire",
    to: "/settings/source-control",
    // Hidden until review guides are on, so a search lands on the switch that shows it.
    targetId: "review-guides",
    searchTerms: ["pull request pr guided review guide brief maintainer"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "review-guide-instructions",
    title: "Instrucțiuni ghid de revizuire",
    to: "/settings/source-control",
    targetId: "review-guides",
    searchTerms: ["pull request pr guided review guide preferences taste prompt custom"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "project-actions",
    title: "Acțiuni",
    to: "/settings/projects",
    searchTerms: ["commands scripts setup run dev server checkout worktree t3.json import"],
  },
  {
    id: "environment-icon",
    title: "Pictograma mediului",
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["machine glyph sidebar mac mini studio laptop desktop server cloud vm"],
  },
  {
    id: "local-environment",
    title: "Mediu local",
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["turn off on disable enable local server agents remote only restart"],
    desktopOnly: true,
  },
  {
    id: "network-access",
    title: "Acces în rețea",
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["expose backend remote pairing local machine interfaces host restart"],
    localBackendManagementOnly: true,
  },
  {
    id: "tailscale-https",
    title: "Tailscale HTTPS",
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["serve magicdns endpoint remote secure network"],
    desktopOnly: true,
    localBackendManagementOnly: true,
  },
  {
    id: "wsl-backend",
    title: "Server WSL",
    to: "/settings/connections",
    searchTerms: [
      "windows subsystem linux distro second server projects stop windows backend restart",
    ],
    desktopOnly: true,
    windowsOnly: true,
    localBackendManagementOnly: true,
    wslAvailableOnly: true,
  },
  {
    id: "t3-connect",
    localEnvironmentOnly: true,
    title: "T3 Connect",
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["managed tunnel cloud other devices remote"],
    desktopOnly: true,
    cloudOnly: true,
  },
  {
    id: "hold-webhooks-while-offline",
    localEnvironmentOnly: true,
    title: "Păstrează webhook-urile cât ești offline",
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["webhook automations offline queue mailbox t3 connect"],
    cloudOnly: true,
    managedTunnelOnly: true,
  },
  {
    id: "publish-agent-activity",
    localEnvironmentOnly: true,
    title: "Publică activitatea agentului",
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["mobile push notifications live activities cloud tunnel"],
    cloudOnly: true,
  },
  {
    id: "connections-environment",
    title: "Acest calculator",
    to: "/settings/connections",
    searchTerms: [
      "connections server backend local remote access administrative permissions scope pairing links qr code authorized clients sessions revoke endpoint",
    ],
  },
  {
    id: "remote-environments",
    title: "Medii",
    to: "/settings/connections",
    searchTerms: ["add pair backend host code ssh config agent tunnel saved t3 connect"],
  },
  {
    id: "load-balancing",
    title: "Echilibrare încărcare",
    to: "/settings/connections",
    searchTerms: [
      "automatic machine environment resources cpu memory capacity preference weight shared projects",
    ],
  },
  {
    id: "pull-request-routing",
    title: "Partajare pull request-uri",
    to: "/settings/connections",
    searchTerms: [
      `pull request routing trusted environments shared credentials permissions read actions source control ${SOURCE_CONTROL_HOST_LABELS}`,
    ],
  },
  {
    id: "archive",
    title: "Conversații arhivate",
    to: "/settings/archived",
    searchTerms: ["restore reopen deleted history projects"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = new Map(SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item] as const));

const SETTINGS_CATEGORY_SCOPES: Readonly<Record<SettingsPath, SettingsSearchScope | null>> = {
  "/settings/diagnostics": "environment",
  "/settings/projects": "project",
  "/settings/general": null,
  "/settings/appearance": null,
  "/settings/snap-shot": null,
  "/settings/keybindings": null,
  "/settings/providers": null,
  "/settings/integrations": null,
  "/settings/source-control": "environment-defaults",
  "/settings/storage": "project-defaults",
  "/settings/connections": "connections",
  "/settings/scheduled-tasks": null,
  "/settings/beta": null,
  "/settings/archived": "project-defaults",
};

export function getSettingsSearchTargetScope(targetId: string) {
  const items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const item =
    items.find((candidate) => candidate.id === targetId) ??
    items.find((candidate) => candidate.targetId === targetId);
  return item
    ? {
        title: item.title,
        scope: item.scope ?? SETTINGS_CATEGORY_SCOPES[item.to],
        ...(item.requiresThreadAutoSettlement ? { requiresThreadAutoSettlement: true } : {}),
      }
    : null;
}

interface AutoSettlementSearchEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: {
    readonly environment: {
      readonly capabilities: { readonly threadAutoSettlement?: boolean };
    };
  } | null;
}

export function getThreadAutoSettlementSearchAvailability(
  environments: readonly AutoSettlementSearchEnvironment[],
  scope?: Pick<ResolvedSettingsScope, "kind" | "environmentIds">,
) {
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const eligibleEnvironmentIds = connected
    .filter(
      (environment) =>
        environment.serverConfig?.environment.capabilities.threadAutoSettlement === true,
    )
    .map((environment) => environment.environmentId);
  const selected = connected.filter((environment) =>
    scope?.environmentIds.includes(environment.environmentId),
  );
  return {
    eligibleEnvironmentIds,
    isTargetAvailable:
      scope !== undefined &&
      scope.kind !== "unavailable" &&
      selected.length > 0 &&
      selected.every((environment) => eligibleEnvironmentIds.includes(environment.environmentId)),
  };
}

export function isSettingsSearchScopeAvailable(
  requiredScope: SettingsSearchScope | null,
  scopeKind: ResolvedSettingsScope["kind"],
): boolean {
  switch (requiredScope) {
    case null:
    case "connections":
      return true;
    case "environment":
    case "checkout":
      return requiredScope === scopeKind;
    case "project":
      return scopeKind === "project" || scopeKind === "checkout";
    case "environment-defaults":
      return scopeKind === "environment" || scopeKind === "all";
    case "project-defaults":
      return (
        scopeKind === "environment" ||
        scopeKind === "all" ||
        scopeKind === "project" ||
        scopeKind === "checkout"
      );
  }
}

function settingsScopeKindFromSearch(search: SettingsScopeSearch): ResolvedSettingsScope["kind"] {
  const target = validateSettingsScopeSearch({ ...search });
  if (target.checkout && !target.project) return "unavailable";
  if (target.project) return target.checkout ? "checkout" : "project";
  return target.machine ? "environment" : "all";
}

export function isSettingsOverviewVisible(search: SettingsScopeSearch): boolean {
  const kind = settingsScopeKindFromSearch(search);
  return kind === "project" || kind === "checkout";
}

export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID.get(id)!;
  return { id: anchorId, title };
}

export function filterAvailableSettingsSearchItems(
  availability: SettingsSearchAvailability,
): ReadonlyArray<SettingsSearchItem> {
  const items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS;
  return items.filter(
    (item) =>
      (!item.cloudOnly || availability.hasCloudPublicConfig) &&
      (!item.environmentOnly || availability.hasEnvironment) &&
      (!item.providerSettingsOnly || availability.hasProviderSettingsEnvironment) &&
      (!item.macProviderSettingsOnly || availability.hasMacProviderSettingsEnvironment) &&
      (!item.localBackendManagementOnly || availability.canManageLocalBackend) &&
      (!item.localEnvironmentOnly || !availability.localEnvironmentDisabled) &&
      (!item.wslAvailableOnly || availability.isWslSettingsRowVisible) &&
      (!item.requiresThreadAutoSettlement || availability.hasThreadAutoSettlement) &&
      (!item.managedTunnelOnly || availability.managedTunnelActive === true),
  );
}

/** The settings that exist on this platform and app channel. */
export function settingsForThisPlatform(
  items: ReadonlyArray<SettingsSearchItem>,
): ReadonlyArray<SettingsSearchItem> {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return items.filter(
    (item) =>
      (isElectron || item.desktopOnly !== true) &&
      (!item.releaseChannelOnly || isElectron || HOSTED_APP_CHANNEL !== null) &&
      (!item.macOnly || isMacPlatform(platform)) &&
      (!item.windowsOnly || isWindowsPlatform(platform)),
  );
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  const queryTokens = normalizedQuery.split(" ");

  return settingsForThisPlatform(items)
    .flatMap((item, index) => {
      const title = normalizeSearchText(item.title);
      const fields = [
        title,
        normalizeSearchText(SETTINGS_SECTION_LABELS[item.to]),
        ...(item.searchTerms ?? []).map(normalizeSearchText),
      ];
      if (!queryTokens.every((token) => fields.some((field) => field.includes(token)))) return [];

      const exactPhraseField = fields.findIndex((field) => field.includes(normalizedQuery));
      const rank =
        title === normalizedQuery
          ? 5
          : title.startsWith(normalizedQuery)
            ? 4
            : title.includes(normalizedQuery)
              ? 3
              : queryTokens.every((token) => title.includes(token))
                ? 2
                : exactPhraseField >= 0
                  ? 1
                  : 0;
      return [{ item, index, rank }];
    })
    .toSorted(
      (left, right) =>
        Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
        right.rank - left.rank ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}
