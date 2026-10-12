/**
 * Muse subscription usage. Meta has no usage endpoint T3 can poll: Muse
 * reports the signed-in account's windows with each reply and forwards them
 * as the MSP `usage/changed` notification (the same payload `usage/read`
 * returns, except that a fresh host has observed nothing). The adapter hands
 * each report to the driver, which publishes it as the instance's
 * `usageLimits` and re-derives the windows from the newest report on every
 * status check. A window whose reset has passed starts over empty.
 *
 * @module server/usageLimits
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
export function museSubscriptionUsageWindows(
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

export function museSubscriptionUsageToLimits(input: {
  readonly usage: MuseSubscriptionUsage;
  readonly checkedAt: string;
  readonly nowMs: number;
}): ServerProviderUsageLimits {
  return makeUsageLimits({
    checkedAt: input.checkedAt,
    windows: museSubscriptionUsageWindows(input.usage, input.nowMs),
  });
}

export function museSubscriptionUsageToUpdate(input: {
  readonly usage: MuseSubscriptionUsage;
  readonly nowMs: number;
}): ProviderUsageLimitsUpdate {
  return { windows: [...museSubscriptionUsageWindows(input.usage, input.nowMs)] };
}
