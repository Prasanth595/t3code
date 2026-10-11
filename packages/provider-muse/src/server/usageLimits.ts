/**
 * Muse Code's subscription usage limits. Meta reports the account's windows
 * with every model response, and Muse forwards them as `usage/changed`. When a
 * window runs out, Meta refuses the next request and Muse fails the turn.
 */
import * as DateTime from "effect/DateTime";

import type { MuseSubscriptionUsage } from "./protocol.ts";

/**
 * Muse surfaces Meta's quota refusal as `API error 429: Subscription quota
 * exhausted… (rate_limit_error)` and drops the reset time Meta sent with it.
 */
export function isMuseUsageLimitFailure(message: string | undefined): boolean {
  return message !== undefined && /\b429\b/.test(message) && /quota|usage limit/i.test(message);
}

/**
 * When a stopped turn can run again: every exhausted window must reset first.
 * The last report before the refusal is the one that crossed the limit.
 */
export function museUsageLimitResetAt(
  usage: MuseSubscriptionUsage | undefined,
  nowMs: number,
): string | null {
  const resets = [usage?.window, usage?.weekly].flatMap((window) =>
    window && window.usedPercent >= 100 && window.resetsAtMs > nowMs ? [window.resetsAtMs] : [],
  );
  return resets.length > 0 ? DateTime.formatIso(DateTime.makeUnsafe(Math.max(...resets))) : null;
}
