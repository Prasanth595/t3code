import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  resolveSnoozePresets as resolveSharedSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

import { formatShortTimestamp, parseTimestampDate } from "../timestampFormat";
import { getClientSettings } from "../hooks/useSettings";

export { snoozeWakeLabel, type SnoozePreset };

function timeOfDayLabel(date: Date, timestampFormat: TimestampFormat): string {
  return formatShortTimestamp(date.toISOString(), timestampFormat);
}

export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
): ReadonlyArray<SnoozePreset> {
  return resolveSharedSnoozePresets(now, getClientSettings().snoozePreferences).map((preset) => {
    const wake = parseTimestampDate(preset.snoozedUntil);
    if (wake === null) return preset;
    const time = timeOfDayLabel(wake, timestampFormat);
    return {
      ...preset,
      whenLabel:
        preset.id === "next-week" ||
        (preset.id.startsWith("preset-") && wake.toDateString() !== now.toDateString())
          ? `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`
          : time,
    };
  });
}

export function resolveSnoozePresetSelection(
  action: string,
  displayedPresets: ReadonlyArray<SnoozePreset>,
  now: Date,
  timestampFormat: TimestampFormat,
) {
  const currentPreset = resolveSnoozePresets(now, timestampFormat).find(
    (candidate) => `snooze:${candidate.id}` === action,
  );
  if (currentPreset) return currentPreset;
  return displayedPresets.find(
    (candidate) =>
      !candidate.id.startsWith("preset-") &&
      `snooze:${candidate.id}` === action &&
      Date.parse(candidate.snoozedUntil) > now.getTime(),
  );
}
