import { useState } from "react";
import * as Schema from "effect/Schema";
import {
  DEFAULT_UNIFIED_SETTINGS,
  DEFAULT_SNOOZE_PRESETS,
  MAX_SNOOZE_HOURS,
  SNOOZE_ABSOLUTE_DAYS,
  SnoozeDay,
  type SnoozePresetSetting,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  SnoozeTime,
} from "@t3tools/contracts/settings";
import { Input } from "../ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { FoldedSettingsSection } from "./FoldedSettingsSection";

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [draftSource, setDraftSource] = useState(value);
  if (draftSource !== value) {
    setDraftSource(value);
    setDraft(String(value));
  }

  return (
    <Input
      size="sm"
      type="number"
      min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
          parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label="Days of inactivity before auto-settle"
    />
  );
}

const isSnoozeTime = Schema.is(SnoozeTime);
const isSnoozeDay = Schema.is(SnoozeDay);

function SnoozeSlotEditor({
  slot,
  index,
  onChange,
}: {
  slot: SnoozePresetSetting;
  index: number;
  onChange: (slot: SnoozePresetSetting) => void;
}) {
  const label = `Snooze slot ${index + 1}`;
  return (
    <div
      role="group"
      aria-label={label}
      className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-3 py-2.5 sm:px-4"
    >
      <div className="w-28 shrink-0">
        <Select
          value={slot.mode}
          onValueChange={(mode) => {
            if (mode === slot.mode) return;
            if (mode === "relative") onChange({ mode, hours: 1 });
            if (mode === "absolute") onChange({ mode, day: "tomorrow", time: "09:00" });
          }}
        >
          <SelectTrigger variant="ghost" size="sm" className="w-full" aria-label={`${label} mode`}>
            <SelectValue>{slot.mode === "relative" ? "Relative" : "Absolute"}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value="relative">Relative</SelectItem>
            <SelectItem value="absolute">Absolute</SelectItem>
          </SelectPopup>
        </Select>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        {slot.mode === "relative" ? (
          <div className="flex shrink-0 items-center gap-2">
            <div className="w-32">
              <NumberField
                size="sm"
                value={slot.hours}
                min={1}
                max={MAX_SNOOZE_HOURS}
                step={1}
                onValueChange={(value) => {
                  if (value !== null) onChange({ ...slot, hours: value });
                }}
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement aria-label={`Decrease ${label.toLowerCase()} hours`} />
                  <NumberFieldInput aria-label={`${label} hours`} />
                  <NumberFieldIncrement aria-label={`Increase ${label.toLowerCase()} hours`} />
                </NumberFieldGroup>
              </NumberField>
            </div>
            <span className="text-xs text-muted-foreground">hours</span>
          </div>
        ) : (
          <>
            <div className="w-36">
              <Select
                value={slot.day}
                onValueChange={(day) => {
                  if (isSnoozeDay(day)) onChange({ ...slot, day });
                }}
              >
                <SelectTrigger size="sm" aria-label={`${label} day`}>
                  <SelectValue>
                    {(day: string) => day.charAt(0).toUpperCase() + day.slice(1)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {SNOOZE_ABSOLUTE_DAYS.map((day) => (
                    <SelectItem key={day} value={day}>
                      {day.charAt(0).toUpperCase() + day.slice(1)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <span className="text-xs text-muted-foreground">at</span>
            <div className="w-32">
              <Input
                size="sm"
                type="time"
                aria-label={`${label} time`}
                value={slot.time}
                onChange={(event) => {
                  if (isSnoozeTime(event.target.value))
                    onChange({ ...slot, time: event.target.value });
                }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function SnoozeAndAutoSettleSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { connectedEnvironments } = useSettingsScope();
  const supportsAutoSettlement =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.threadAutoSettlement === true,
    );
  const supportsAutoSettlementScope = connectedEnvironments.every(
    (target) => target.serverConfig?.environment.capabilities.threadAutoSettlementScope === true,
  );
  const preferences = settings.snoozePreferences ?? DEFAULT_SNOOZE_PRESETS;

  return (
    <>
      <FoldedSettingsSection
        id="snooze-presets"
        title="Snooze"
        headerPlacement="outside"
        control={
          settings.snoozePreferences !== null ? (
            <SettingResetButton
              label="snooze presets"
              onClick={() => updateSettings({ snoozePreferences: null })}
            />
          ) : null
        }
      >
        {[0, 1, 2, 3, 4].map((index) => (
          <SnoozeSlotEditor
            key={index}
            slot={preferences[index]!}
            index={index}
            onChange={(next) =>
              updateSettings({
                snoozePreferences: preferences.map((current, currentIndex) =>
                  currentIndex === index ? next : current,
                ),
              })
            }
          />
        ))}
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          Presets stay in this order and use your local time zone.
        </p>
      </FoldedSettingsSection>
      <SettingsSection id="auto-settle" title="Auto-settle">
        {supportsAutoSettlement ? (
          <>
            <SettingsRow
              serverScoped
              settingKeys={["sidebarAutoSettleOnMerge"]}
              {...searchableSetting("auto-settle-merged-threads")}
              description="Settle a thread when its pull request merges. Closed pull requests still settle automatically."
              resetAction={
                settings.sidebarAutoSettleOnMerge !==
                DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge ? (
                  <SettingResetButton
                    label="auto-settle on merge"
                    onClick={() =>
                      updateSettings({
                        sidebarAutoSettleOnMerge: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
                      })
                    }
                  />
                ) : null
              }
              control={
                <ScopedSwitch
                  settingKeys={["sidebarAutoSettleOnMerge"]}
                  checked={settings.sidebarAutoSettleOnMerge}
                  onCheckedChange={(checked) =>
                    updateSettings({ sidebarAutoSettleOnMerge: Boolean(checked) })
                  }
                  aria-label="Auto-settle merged threads"
                />
              }
            />

            <SettingsRow
              serverScoped
              settingKeys={["sidebarAutoSettleAfterDays"]}
              {...searchableSetting("auto-settle-inactive-threads")}
              description="Sidebar threads with no activity for this long settle automatically."
              resetAction={
                settings.sidebarAutoSettleAfterDays !==
                DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ? (
                  <SettingResetButton
                    label="auto-settle"
                    onClick={() =>
                      updateSettings({
                        sidebarAutoSettleAfterDays:
                          DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
                      })
                    }
                  />
                ) : null
              }
              control={
                <ScopedSwitch
                  settingKeys={["sidebarAutoSettleAfterDays"]}
                  checked={settings.sidebarAutoSettleAfterDays !== null}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      sidebarAutoSettleAfterDays: checked ? AUTO_SETTLE_DEFAULT_DAYS : null,
                    })
                  }
                  aria-label="Auto-settle inactive threads"
                />
              }
            />
            {settings.sidebarAutoSettleAfterDays !== null ? (
              <SettingsRow
                serverScoped
                settingKeys={["sidebarAutoSettleAfterDays"]}
                title={searchableSetting("days-before-auto-settle").title}
                description="Any new activity un-settles a thread automatically."
                control={
                  <AutoSettleDaysInput
                    value={settings.sidebarAutoSettleAfterDays}
                    onCommit={(days) => updateSettings({ sidebarAutoSettleAfterDays: days })}
                  />
                }
              />
            ) : null}
            {settings.sidebarAutoSettleAfterDays !== null && supportsAutoSettlementScope ? (
              <SettingsRow
                serverScoped
                settingKeys={["sidebarAutoSettleKeepPullRequests"]}
                title="Keep threads with a PR"
                description="Inactivity does not settle threads with a pull request. Merge and close still do."
                control={
                  <ScopedSwitch
                    settingKeys={["sidebarAutoSettleKeepPullRequests"]}
                    checked={settings.sidebarAutoSettleKeepPullRequests}
                    onCheckedChange={(checked) =>
                      updateSettings({ sidebarAutoSettleKeepPullRequests: checked })
                    }
                    aria-label="Keep threads with a PR"
                  />
                }
              />
            ) : null}
          </>
        ) : null}
        {!supportsAutoSettlement ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Connect an environment that supports auto-settle to change these settings.
          </p>
        ) : null}
      </SettingsSection>
    </>
  );
}
