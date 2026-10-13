import type { TimestampFormat } from "@t3tools/contracts/settings";

import { getClientSettings } from "../hooks/useSettings";
import {
  resolveSnoozePresets as resolveBuiltInSnoozePresets,
  type SnoozePreset,
} from "./Sidebar.snooze";
import { resolveSnoozeQuickOptions } from "./snoozeQuickOptions.logic";

/**
 * Fork: the options of every web snooze menu. They come from the `snoozeQuickOptions` setting, or
 * are the built-in options while it is null. Menus resolve them when they open, so this reads the
 * setting without a subscription. If upstream T3 Code makes the snooze presets editable, drop
 * this fork version and use theirs.
 */
export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
): ReadonlyArray<SnoozePreset> {
  const options = getClientSettings().snoozeQuickOptions;
  return options === null
    ? resolveBuiltInSnoozePresets(now, timestampFormat)
    : resolveSnoozeQuickOptions(options, now, timestampFormat);
}
