/**
 * The fork parts of `SettingsPanels.tsx`. It imports this module once and renders one component
 * per place, so the upstream file keeps one line per hook.
 */
import { isElectron } from "../../env";
import { AppToggleShortcutsSettingsRow } from "./AppToggleShortcutsSettingsRow";
import { ForkChangelogSettingsRow } from "./ForkChangelogSettingsRow";
import {
  BackgroundWorkDetailsSettingsRow,
  CheckNewerBeforeUpdateInstallSettingsRow,
  ForkAutoUpdateSettingsRow,
  TerminalAppShortcutsFirstSettingsRow,
  TerminalCloseConfirmationSettingsRow,
} from "./ForkSettingsRows";
import { InstalledAppSettingsRow } from "./InstalledAppSettingsRow";
import { PullRequestFilterChipsSettingsRow } from "./PullRequestFilterChipsSettingsRow";
import { RepositoryOwnerFiltersSettingsRow } from "./RepositoryOwnerFiltersSettingsRow";
import { SidebarGroupsSettingsRow } from "./SidebarGroupsSettingsRow";
import { SnoozeQuickOptionsSettingsRow } from "./SnoozeQuickOptionsSettingsRow";
import { ThreadCardLayoutSettingsSection } from "./ThreadCardLayoutSettings";
import { ThreadLinkChipsSettingsSection } from "./ThreadLinkChipsSettings";
import { WebPushSettingsRow } from "./WebPushSettingsRow";

export { GlobalScriptsSettings } from "./GlobalScriptsSettings";
export { RecoverInterruptedTurnsSettings } from "./RecoverInterruptedTurnsSettings";
export { AgentSessionImportSettingsRows } from "./ForkSettingsRows";
export { FORK_SETTINGS_RESTORE_PATCH, forkChangedSettingLabels } from "./forkSettingsRestore";
export {
  openIdleInstallPromptIfAgentsRun,
  useIdleInstallArmed,
} from "../desktop/DesktopUpdateIdleInstall";
export { prepareNewestUpdateInstall } from "../desktop/DesktopUpdateNewerCheck";

/** Appearance: after the upstream sections, before Motion. */
export function AppearanceSections() {
  return (
    <>
      <ThreadCardLayoutSettingsSection />
      <ThreadLinkChipsSettingsSection />
    </>
  );
}

/** General > Behavior: after the notification settings. */
export function NotificationRows() {
  return (
    <>
      <InstalledAppSettingsRow />
      <WebPushSettingsRow />
    </>
  );
}

/** General > Confirmations: before the quit shortcut. */
export function BehaviorRows() {
  return (
    <>
      <TerminalCloseConfirmationSettingsRow />

      <TerminalAppShortcutsFirstSettingsRow />

      {isElectron ? <AppToggleShortcutsSettingsRow /> : null}

      <RepositoryOwnerFiltersSettingsRow />

      <PullRequestFilterChipsSettingsRow />

      <SidebarGroupsSettingsRow />

      <SnoozeQuickOptionsSettingsRow />

      <BackgroundWorkDetailsSettingsRow />
    </>
  );
}

/** General > About: after the update rows. */
export function AboutRows() {
  return (
    <>
      <ForkChangelogSettingsRow />
      <ForkAutoUpdateSettingsRow />
      <CheckNewerBeforeUpdateInstallSettingsRow />
    </>
  );
}
