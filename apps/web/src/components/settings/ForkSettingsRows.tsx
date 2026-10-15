import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_AGENT_SESSION_IMPORT_MAX_MESSAGES,
  MAX_AGENT_SESSION_IMPORT_WINDOW_DAYS,
  MIN_AGENT_SESSION_IMPORT_MAX_MESSAGES,
  MIN_AGENT_SESSION_IMPORT_WINDOW_DAYS,
} from "@t3tools/contracts/settings";

import { Switch } from "../ui/switch";
import { BoundedIntegerInput } from "./BoundedIntegerInput";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/**
 * Fork: setting rows that the General page and the Fork page both render.
 * Each row edits the same value in both places.
 */

/** Fork: `agentSessionImportWindowDays` and `agentSessionImportMaxMessages`. */
export function AgentSessionImportSettingsRows() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["agentSessionImportWindowDays"]}
        {...searchableSetting("agent-session-import-window")}
        description="Claude Code and Codex sessions active within this many days are offered for import."
        resetAction={
          settings.agentSessionImportWindowDays !==
          DEFAULT_UNIFIED_SETTINGS.agentSessionImportWindowDays ? (
            <SettingResetButton
              label="session import window"
              onClick={() =>
                updateSettings({
                  agentSessionImportWindowDays:
                    DEFAULT_UNIFIED_SETTINGS.agentSessionImportWindowDays,
                })
              }
            />
          ) : null
        }
        control={
          <BoundedIntegerInput
            value={settings.agentSessionImportWindowDays}
            min={MIN_AGENT_SESSION_IMPORT_WINDOW_DAYS}
            max={MAX_AGENT_SESSION_IMPORT_WINDOW_DAYS}
            onCommit={(value) => updateSettings({ agentSessionImportWindowDays: value })}
            aria-label="Days of session history offered for import"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["agentSessionImportMaxMessages"]}
        {...searchableSetting("agent-session-import-max-messages")}
        description="Newest messages kept per imported session. The first prompt is always kept."
        resetAction={
          settings.agentSessionImportMaxMessages !==
          DEFAULT_UNIFIED_SETTINGS.agentSessionImportMaxMessages ? (
            <SettingResetButton
              label="imported messages per session"
              onClick={() =>
                updateSettings({
                  agentSessionImportMaxMessages:
                    DEFAULT_UNIFIED_SETTINGS.agentSessionImportMaxMessages,
                })
              }
            />
          ) : null
        }
        control={
          <BoundedIntegerInput
            value={settings.agentSessionImportMaxMessages}
            min={MIN_AGENT_SESSION_IMPORT_MAX_MESSAGES}
            max={MAX_AGENT_SESSION_IMPORT_MAX_MESSAGES}
            onCommit={(value) => updateSettings({ agentSessionImportMaxMessages: value })}
            aria-label="Messages kept per imported session"
          />
        }
      />
    </>
  );
}

/** Fork: `confirmTerminalClose`. */
export function TerminalCloseConfirmationSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("terminal-close-confirmation")}
      description="Ask before closing a terminal and stopping its process."
      resetAction={
        settings.confirmTerminalClose !== DEFAULT_UNIFIED_SETTINGS.confirmTerminalClose ? (
          <SettingResetButton
            label="terminal close confirmation"
            onClick={() =>
              updateSettings({
                confirmTerminalClose: DEFAULT_UNIFIED_SETTINGS.confirmTerminalClose,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.confirmTerminalClose}
          onCheckedChange={(checked) => updateSettings({ confirmTerminalClose: Boolean(checked) })}
          aria-label="Confirm terminal close"
        />
      }
    />
  );
}

/** Fork: `terminalAppShortcutsFirst`. */
export function TerminalAppShortcutsFirstSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("terminal-app-shortcuts-first")}
      description="When the terminal has focus, keys that match an app keybinding run the app command instead of going to the shell."
      resetAction={
        settings.terminalAppShortcutsFirst !==
        DEFAULT_UNIFIED_SETTINGS.terminalAppShortcutsFirst ? (
          <SettingResetButton
            label="app shortcuts in terminal"
            onClick={() =>
              updateSettings({
                terminalAppShortcutsFirst: DEFAULT_UNIFIED_SETTINGS.terminalAppShortcutsFirst,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.terminalAppShortcutsFirst}
          onCheckedChange={(checked) =>
            updateSettings({ terminalAppShortcutsFirst: Boolean(checked) })
          }
          aria-label="App shortcuts take priority in terminal"
        />
      }
    />
  );
}

/** Fork: `backgroundWorkDetails`. */
export function BackgroundWorkDetailsSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("background-work-details")}
      description="Click the status icon of a monitor, background command, or background agent to see its command and output file. Links in their descriptions open."
      resetAction={
        settings.backgroundWorkDetails !== DEFAULT_UNIFIED_SETTINGS.backgroundWorkDetails ? (
          <SettingResetButton
            label="background work details"
            onClick={() =>
              updateSettings({
                backgroundWorkDetails: DEFAULT_UNIFIED_SETTINGS.backgroundWorkDetails,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.backgroundWorkDetails}
          onCheckedChange={(checked) => updateSettings({ backgroundWorkDetails: Boolean(checked) })}
          aria-label="Background work details"
        />
      }
    />
  );
}

/** Fork: `forkAutoUpdate`. Only a server that runs as the background service uses it. */
export function ForkAutoUpdateSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["forkAutoUpdate"]);
  return (
    <SettingsRow
      {...searchableSetting("fork-auto-update")}
      serverScoped
      settingKeys={["forkAutoUpdate"]}
      description="A server that runs as the background service installs each newer fork release when no agent runs. The desktop app ignores it and uses its own updater."
      resetAction={
        mixed || settings.forkAutoUpdate !== DEFAULT_UNIFIED_SETTINGS.forkAutoUpdate ? (
          <SettingResetButton
            label="server auto-update"
            onClick={() =>
              updateSettings({ forkAutoUpdate: DEFAULT_UNIFIED_SETTINGS.forkAutoUpdate })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["forkAutoUpdate"]}
          checked={settings.forkAutoUpdate}
          onCheckedChange={(checked) => updateSettings({ forkAutoUpdate: Boolean(checked) })}
          aria-label="Server auto-update"
        />
      }
    />
  );
}
