import type { ServerProviderResetCredits, ServerProviderUsageLimits } from "@t3tools/contracts";

export interface ResetAvailability {
  readonly weekly: boolean;
  readonly banked: ServerProviderResetCredits | null;
  /** Set only when no reset is known to be available. */
  readonly unavailable: "No reset available" | "Reset status unknown" | null;
}

/**
 * Null for sources that do not report the weekly at-limit reset, which keep their existing display.
 * "None" needs both halves confirmed, so a missing half never reads as no.
 */
export function resetAvailability(limits: ServerProviderUsageLimits): ResetAvailability | null {
  if (!limits.atLimitReset) return null;
  const weekly = limits.atLimitReset.available === true;
  const credits = limits.resetCredits;
  const banked = credits && credits.availableCount > 0 ? credits : null;
  const unavailable =
    weekly || banked
      ? null
      : limits.atLimitReset.available === false && credits
        ? "No reset available"
        : "Reset status unknown";
  return { weekly, banked, unavailable };
}
