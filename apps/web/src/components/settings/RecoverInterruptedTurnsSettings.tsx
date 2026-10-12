import { useRef } from "react";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { Input } from "../ui/input";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

type MessageKey = "recoverInterruptedTurnsMessage" | "recoverInterruptedTurnsSubagentMessage";

/** Fork: the switch and the two messages of `recoverInterruptedTurns`. */
export function RecoverInterruptedTurnsSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const switchMixed = useScopedSettingsMixed(["recoverInterruptedTurns"]);

  return (
    <>
      <SettingsRow
        {...searchableSetting("recover-interrupted-turns")}
        serverScoped
        settingKeys={["recoverInterruptedTurns"]}
        description="After an update, crash, or quit, send a message to each thread whose agent the restart stopped. This includes agents that waited on background work, such as their own subagents."
        resetAction={
          switchMixed ||
          settings.recoverInterruptedTurns !== DEFAULT_SERVER_SETTINGS.recoverInterruptedTurns ? (
            <SettingResetButton
              label="recover interrupted agents"
              onClick={() =>
                updateSettings({
                  recoverInterruptedTurns: DEFAULT_SERVER_SETTINGS.recoverInterruptedTurns,
                })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["recoverInterruptedTurns"]}
            checked={settings.recoverInterruptedTurns}
            onCheckedChange={(checked) =>
              updateSettings({ recoverInterruptedTurns: Boolean(checked) })
            }
            aria-label="Recover interrupted agents"
          />
        }
      />
      {!switchMixed && settings.recoverInterruptedTurns ? (
        <>
          <RecoveryMessageRow
            settingKey="recoverInterruptedTurnsMessage"
            title="Recovery message"
            description="Sent to a thread that the restart stopped."
          />
          <RecoveryMessageRow
            settingKey="recoverInterruptedTurnsSubagentMessage"
            title="Delegated thread recovery message"
            description="Sent instead to a thread that another thread delegated work to."
          />
        </>
      ) : null}
    </>
  );
}

function RecoveryMessageRow(props: {
  readonly settingKey: MessageKey;
  readonly title: string;
  readonly description: string;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const mixed = useScopedSettingsMixed([props.settingKey]);
  const edited = useRef(false);
  const value = settings[props.settingKey];
  const defaultValue = DEFAULT_SERVER_SETTINGS[props.settingKey];

  return (
    <SettingsRow
      serverScoped
      settingKeys={[props.settingKey]}
      title={props.title}
      description={props.description}
      resetAction={
        mixed || value !== defaultValue ? (
          <SettingResetButton
            label={props.title.toLowerCase()}
            onClick={() => updateSettings({ [props.settingKey]: defaultValue })}
          />
        ) : null
      }
      control={
        <Input
          key={`${scopeKey}:${mixed}:${value}`}
          aria-label={props.title}
          onChange={() => {
            edited.current = true;
          }}
          placeholder={mixed ? "Mixed" : defaultValue}
          defaultValue={mixed ? "" : value}
          onBlur={(event) => {
            // The message cannot be empty; clearing it restores the default.
            const next = event.target.value.trim() || defaultValue;
            if (edited.current && (mixed || next !== value))
              updateSettings({ [props.settingKey]: next });
            edited.current = false;
          }}
        />
      }
    />
  );
}
