import { useRef } from "react";

import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Fork: the `threadBackupMachine` setting (fork/threadBackup/ThreadBackups.ts). */
export function ThreadBackupMachineRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["threadBackupMachine"]);
  const edited = useRef(false);
  return (
    <SettingsRow
      {...searchableSetting("thread-backup-machine")}
      description="The machine map name of a machine that keeps a copy of the transcripts of this machine's threads. While this machine is offline, Continue on another machine reads that copy. The arrow to that machine must allow standard access. Leave empty to keep no copy."
      serverScoped
      settingKeys={["threadBackupMachine"]}
      resetAction={
        mixed || settings.threadBackupMachine !== "" ? (
          <SettingResetButton
            label="thread backups"
            onClick={() => updateSettings({ threadBackupMachine: "" })}
          />
        ) : null
      }
      control={
        <Input
          key={`${mixed}:${settings.threadBackupMachine}`}
          aria-label="Thread backup machine"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={mixed ? "Mixed" : "Off"}
          defaultValue={mixed ? "" : settings.threadBackupMachine}
          onChange={() => {
            edited.current = true;
          }}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (edited.current && (mixed || value !== settings.threadBackupMachine)) {
              updateSettings({ threadBackupMachine: value });
            }
            edited.current = false;
          }}
        />
      }
    />
  );
}
