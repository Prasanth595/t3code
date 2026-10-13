/**
 * Muse subscription usage. Meta has no usage endpoint T3 can poll: Muse
 * reports the signed-in account's windows with each reply and forwards them
 * as the MSP `usage/changed` notification. The adapter hands each report to
 * the driver, which publishes it as the instance's `usageLimits` and
 * re-derives the windows from the newest report on every status check.
 *
 * A report is the account's whole state, so live updates replace the
 * published windows: a window whose reset has passed starts over empty,
 * with no reset time until Meta reports the next one. Limits are dated when
 * Meta reported them (`observedAtMs`), so the freshest report wins when
 * Limits merges environments.
 *
 * Which Meta account a report belongs to is not decided here: usage
 * attribution per session host is tracked separately in #17397.
 */
import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { clampPercent, makeUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import type { MuseSubscriptionUsage } from "./protocol.ts";

const WEEK_MINS = 7 * 24 * 60;

function isoFromEpochMs(value: number): string | undefined {
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function window(input: {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAtMs: number;
  readonly windowDurationMins: number;
  readonly nowMs: number;
}): ServerProviderUsageWindow {
  // Meta opens the next window with the account's next request, so a window
  // that has reset since the report is empty and its new reset is unknown.
  const expired = input.resetsAtMs <= input.nowMs;
  const resetsAt = expired ? undefined : isoFromEpochMs(input.resetsAtMs);
  return {
    id: input.id,
    kind: input.kind,
    label: input.label,
    usedPercent: expired ? 0 : clampPercent(input.usedPercent),
    windowDurationMins: input.windowDurationMins,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/** The two subscription windows a Muse report names, as T3 limit windows. */
function museSubscriptionUsageWindows(
  usage: MuseSubscriptionUsage,
  nowMs: number,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [
    window({
      id: "session",
      kind: "session",
      label: "Session",
      usedPercent: usage.window.usedPercent,
      resetsAtMs: usage.window.resetsAtMs,
      windowDurationMins: usage.window.windowDurationMins,
      nowMs,
    }),
    window({
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: usage.weekly.usedPercent,
      resetsAtMs: usage.weekly.resetsAtMs,
      windowDurationMins: WEEK_MINS,
      nowMs,
    }),
  ];
}

/** Whether a report is newer than the one already retained, by Meta's observation time. */
export function isNewerMuseUsageReport(
  previous: MuseSubscriptionUsage | undefined,
  next: MuseSubscriptionUsage,
): boolean {
  return previous === undefined || next.observedAtMs > previous.observedAtMs;
}

/** Limits as of `nowMs`, dated when Meta reported them. */
export function museSubscriptionUsageToLimits(input: {
  readonly usage: MuseSubscriptionUsage;
  readonly nowMs: number;
}): ServerProviderUsageLimits {
  return makeUsageLimits({
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(input.usage.observedAtMs)),
    windows: museSubscriptionUsageWindows(input.usage, input.nowMs),
  });
}

/** A live whole-state update for a report, to publish with `replace: true`. */
export function museSubscriptionUsageToUpdate(input: {
  readonly usage: MuseSubscriptionUsage;
  readonly nowMs: number;
}): ProviderUsageLimitsUpdate & { readonly checkedAt: string; readonly replace: true } {
  return {
    windows: [...museSubscriptionUsageWindows(input.usage, input.nowMs)],
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(input.usage.observedAtMs)),
    replace: true,
  };
}
