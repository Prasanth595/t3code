/**
 * Fork: the snooze menu options of the `snoozeQuickOptions` client setting. If upstream T3 Code
 * makes the snooze presets editable, drop this fork version and use theirs.
 */
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import type {
  SnoozeQuickOption,
  SnoozeQuickOptionDay,
  TimestampFormat,
} from "@t3tools/contracts/settings";

import { formatShortTimestamp } from "../timestampFormat";
import { snoozeWakeDescription } from "./Sidebar.snooze";

const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
/** In `Date.getDay()` order. */
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const satisfies ReadonlyArray<SnoozeQuickOptionDay>;

/** The built-in snooze options, as the setting spells them. The settings editor starts here. */
export const BUILT_IN_SNOOZE_QUICK_OPTIONS: ReadonlyArray<SnoozeQuickOption> = [
  { _tag: "in", amount: 1, unit: "hours" },
  { _tag: "in", amount: 3, unit: "hours" },
  { _tag: "at", day: "today", time: { hour: 18, minute: 0 }, label: "This evening" },
  { _tag: "at", day: "tomorrow", time: { hour: 9, minute: 0 } },
  { _tag: "at", day: "monday", time: { hour: 9, minute: 0 }, label: "Next week" },
];

const capitalize = (word: string) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

/** The label that names the option, such as "In 3 hours" or "Tomorrow". */
export function snoozeQuickOptionDefaultLabel(option: SnoozeQuickOption): string {
  if (option._tag === "at") return capitalize(option.day);
  const unit = option.amount === 1 ? option.unit.slice(0, -1) : option.unit;
  return `In ${option.amount} ${unit}`;
}

/** The menu label: the custom label, or the default label. */
export const snoozeQuickOptionLabel = (option: SnoozeQuickOption): string =>
  option.label ?? snoozeQuickOptionDefaultLabel(option);

/** The option with a custom label, or without one for blank text. */
export function withSnoozeQuickOptionLabel(
  option: SnoozeQuickOption,
  text: string,
): SnoozeQuickOption {
  const trimmed = text.trim();
  const label = trimmed.length === 0 ? {} : { label: trimmed };
  return option._tag === "in"
    ? { _tag: "in", amount: option.amount, unit: option.unit, ...label }
    : { _tag: "at", day: option.day, time: option.time, ...label };
}

/** Days from today to the option's day: 0 today, 1 tomorrow, 1 to 7 for the next weekday. */
function dayOffset(day: SnoozeQuickOptionDay, now: Date): number {
  if (day === "today") return 0;
  if (day === "tomorrow") return 1;
  return (WEEKDAYS.indexOf(day) - now.getDay() + 7) % 7 || 7;
}

/**
 * The wake time, or null when the option does not apply now. A time today applies while it is
 * more than an hour away, as the built-in "This evening" does, so that it never sits next to
 * "In 1 hour" with almost the same time.
 */
function snoozeQuickOptionWake(option: SnoozeQuickOption, now: Date): Date | null {
  const wake = new Date(now);
  if (option._tag === "in") {
    // Calendar days, not 24 hours, so that a day across a DST change keeps its clock time.
    if (option.unit === "days") wake.setDate(wake.getDate() + option.amount);
    else
      wake.setTime(now.getTime() + option.amount * (option.unit === "hours" ? HOUR_MS : MINUTE_MS));
    return wake;
  }
  wake.setDate(wake.getDate() + dayOffset(option.day, now));
  wake.setHours(option.time.hour, option.time.minute, 0, 0);
  if (option.day === "today" && wake.getTime() - now.getTime() <= HOUR_MS) return null;
  return wake;
}

/**
 * The menu options for the setting, in its order. An option that lands on the same time as an
 * earlier one is left out, as the built-in "Next week" is on Sundays. The time column complements
 * the label: "Today" and "Tomorrow" pair with the time alone, other labels with the day and time.
 */
export function resolveSnoozeQuickOptions(
  options: ReadonlyArray<SnoozeQuickOption>,
  now: Date,
  timestampFormat: TimestampFormat,
): ReadonlyArray<SnoozePreset> {
  const seen = new Set<number>();
  return options.flatMap((option, index): SnoozePreset[] => {
    const wake = snoozeQuickOptionWake(option, now);
    if (wake === null || seen.has(wake.getTime())) return [];
    seen.add(wake.getTime());
    const snoozedUntil = wake.toISOString();
    const labelNamesDay =
      option._tag === "at" &&
      option.label === undefined &&
      (option.day === "today" || option.day === "tomorrow");
    return [
      {
        id: `custom-${index}`,
        label: snoozeQuickOptionLabel(option),
        whenLabel: labelNamesDay
          ? formatShortTimestamp(snoozedUntil, timestampFormat)
          : snoozeWakeDescription(snoozedUntil, now, timestampFormat),
        snoozedUntil,
      },
    ];
  });
}

/** What the editor's first column picks: a duration, or the day of a time. */
export type SnoozeQuickOptionWhen = "in" | SnoozeQuickOptionDay;

export const snoozeQuickOptionWhen = (option: SnoozeQuickOption): SnoozeQuickOptionWhen =>
  option._tag === "in" ? "in" : option.day;

/** The option with a new "when". It keeps the label, and the duration or time where it can. */
export function withSnoozeQuickOptionWhen(
  option: SnoozeQuickOption,
  when: SnoozeQuickOptionWhen,
): SnoozeQuickOption {
  const label = option.label === undefined ? {} : { label: option.label };
  if (when === "in") {
    return option._tag === "in" ? option : { _tag: "in", amount: 1, unit: "hours", ...label };
  }
  const time = option._tag === "at" ? option.time : { hour: 9, minute: 0 };
  return { _tag: "at", day: when, time, ...label };
}

const twoDigits = (value: number) => String(value).padStart(2, "0");

/** "09:05", the value of a time input. */
export const formatSnoozeTime = (time: { readonly hour: number; readonly minute: number }) =>
  `${twoDigits(time.hour)}:${twoDigits(time.minute)}`;

/** Reads a time input value, "HH:MM" or "HH:MM:SS". Null for anything else. */
export function parseSnoozeTime(text: string): { hour: number; minute: number } | null {
  const [hourText, minuteText] = text.split(":");
  if (hourText === undefined || minuteText === undefined) return null;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}
