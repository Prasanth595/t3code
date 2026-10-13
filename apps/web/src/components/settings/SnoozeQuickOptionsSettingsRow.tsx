import {
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  MAX_SNOOZE_QUICK_OPTIONS,
  type SnoozeQuickOption,
} from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import {
  BUILT_IN_SNOOZE_QUICK_OPTIONS,
  formatSnoozeTime,
  parseSnoozeTime,
  snoozeQuickOptionDefaultLabel,
  snoozeQuickOptionWhen,
  type SnoozeQuickOptionWhen,
  withSnoozeQuickOptionLabel,
  withSnoozeQuickOptionWhen,
} from "../snoozeQuickOptions.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectSnoozeQuickOptions = (settings: ClientSettings) => settings.snoozeQuickOptions;

const WHEN_OPTIONS = [
  { value: "in", label: "In" },
  { value: "today", label: "Today at" },
  { value: "tomorrow", label: "Tomorrow at" },
  { value: "monday", label: "Monday at" },
  { value: "tuesday", label: "Tuesday at" },
  { value: "wednesday", label: "Wednesday at" },
  { value: "thursday", label: "Thursday at" },
  { value: "friday", label: "Friday at" },
  { value: "saturday", label: "Saturday at" },
  { value: "sunday", label: "Sunday at" },
] as const satisfies ReadonlyArray<{ value: SnoozeQuickOptionWhen; label: string }>;

const UNIT_OPTIONS = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
] as const;

const NEW_OPTION: SnoozeQuickOption = { _tag: "in", amount: 30, unit: "minutes" };

/**
 * A key per option that changes with the option, so that the inputs start again from the saved
 * values. A count tells equal options apart.
 */
function optionKeys(options: ReadonlyArray<SnoozeQuickOption>): string[] {
  const seen = new Map<string, number>();
  return options.map((option) => {
    const json = JSON.stringify(option);
    const count = seen.get(json) ?? 0;
    seen.set(json, count + 1);
    return `${json}#${count}`;
  });
}

/**
 * Fork: `snoozeQuickOptions`, the choices of the web and desktop snooze menus. The list starts
 * from the built-in choices, and the first change saves the whole list. If upstream T3 Code makes
 * the snooze presets editable, drop this fork version and use theirs.
 */
export function SnoozeQuickOptionsSettingsRow() {
  const saved = useClientSettings(selectSnoozeQuickOptions);
  const updateSettings = useUpdateClientSettings();
  const options = saved ?? BUILT_IN_SNOOZE_QUICK_OPTIONS;
  const keys = optionKeys(options);
  const save = (next: ReadonlyArray<SnoozeQuickOption>) =>
    void updateSettings({ snoozeQuickOptions: next });
  const replace = (index: number, option: SnoozeQuickOption) =>
    save(options.map((current, at) => (at === index ? option : current)));
  const move = (index: number, offset: -1 | 1) => {
    const target = options[index + offset];
    const option = options[index];
    if (target === undefined || option === undefined) return;
    save(
      options.map((current, at) =>
        at === index ? target : at === index + offset ? option : current,
      ),
    );
  };

  return (
    <SettingsRow
      {...searchableSetting("snooze-quick-options")}
      description="The choices in the snooze menus. Each one snoozes for a time, or until a time of day. A time today shows while it is more than an hour away. The mobile app keeps the built-in choices."
      resetAction={
        saved !== DEFAULT_CLIENT_SETTINGS.snoozeQuickOptions ? (
          <SettingResetButton
            label="snooze quick options"
            onClick={() =>
              void updateSettings({
                snoozeQuickOptions: DEFAULT_CLIENT_SETTINGS.snoozeQuickOptions,
              })
            }
          />
        ) : null
      }
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={options.length >= MAX_SNOOZE_QUICK_OPTIONS}
          onClick={() => save([...options, NEW_OPTION])}
        >
          <PlusIcon />
          Add choice
        </Button>
      }
    >
      <ul className="flex flex-col gap-2 pb-2" aria-label="Snooze quick options">
        {options.map((option, index) => (
          <li key={keys[index]} className="flex flex-wrap items-center gap-2">
            <Select
              value={snoozeQuickOptionWhen(option)}
              onValueChange={(when) => {
                const choice = WHEN_OPTIONS.find((candidate) => candidate.value === when);
                if (choice) replace(index, withSnoozeQuickOptionWhen(option, choice.value));
              }}
            >
              <SelectTrigger size="sm" className="w-36" aria-label="When">
                <SelectValue>
                  {
                    WHEN_OPTIONS.find((choice) => choice.value === snoozeQuickOptionWhen(option))
                      ?.label
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {WHEN_OPTIONS.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {option._tag === "in" ? (
              <>
                <Input
                  type="number"
                  size="sm"
                  className="w-16"
                  min={1}
                  max={999}
                  defaultValue={option.amount}
                  aria-label="Amount"
                  onBlur={(event) => {
                    const amount = Number(event.currentTarget.value);
                    if (!Number.isInteger(amount) || amount < 1 || amount > 999) {
                      event.currentTarget.value = String(option.amount);
                      return;
                    }
                    if (amount !== option.amount) replace(index, { ...option, amount });
                  }}
                />
                <Select
                  value={option.unit}
                  onValueChange={(unit) => {
                    const choice = UNIT_OPTIONS.find((candidate) => candidate.value === unit);
                    if (choice) replace(index, { ...option, unit: choice.value });
                  }}
                >
                  <SelectTrigger size="sm" className="w-28" aria-label="Unit">
                    <SelectValue>{option.unit}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {UNIT_OPTIONS.map((choice) => (
                      <SelectItem key={choice.value} value={choice.value}>
                        {choice.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </>
            ) : (
              <Input
                type="time"
                size="sm"
                className="w-28"
                defaultValue={formatSnoozeTime(option.time)}
                aria-label="Time"
                onBlur={(event) => {
                  const time = parseSnoozeTime(event.currentTarget.value);
                  if (time === null) {
                    event.currentTarget.value = formatSnoozeTime(option.time);
                    return;
                  }
                  if (formatSnoozeTime(time) !== formatSnoozeTime(option.time)) {
                    replace(index, { ...option, time });
                  }
                }}
              />
            )}
            <Input
              size="sm"
              className="w-40"
              defaultValue={option.label ?? ""}
              placeholder={snoozeQuickOptionDefaultLabel(option)}
              aria-label="Label"
              onBlur={(event) => {
                const next = withSnoozeQuickOptionLabel(option, event.currentTarget.value);
                if (next.label !== option.label) replace(index, next);
              }}
            />
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Move up"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Move down"
              disabled={index === options.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDownIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Remove"
              onClick={() => save(options.filter((_, at) => at !== index))}
            >
              <XIcon />
            </Button>
          </li>
        ))}
      </ul>
    </SettingsRow>
  );
}
