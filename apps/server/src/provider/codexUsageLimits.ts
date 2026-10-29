import type {
  ProviderUsageLimitsUpdate,
  ServerProviderResetCredits,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type * as CodexErrors from "effect-codex-app-server/errors";

import { clampPercent, makeUsageLimits } from "@t3tools/provider-core/server/usageLimits";

interface CodexRateLimitWindow {
  readonly usedPercent: number;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
}

export interface CodexRateLimitSnapshot {
  readonly limitId?: string | null;
  readonly planType?: string | null;
  readonly rateLimitReachedType?: string | null;
  readonly primary?: CodexRateLimitWindow | null;
  readonly secondary?: CodexRateLimitWindow | null;
  readonly individualLimit?: {
    readonly remainingPercent: number;
    readonly resetsAt: number;
  } | null;
}

export interface CodexResetCreditsSummary {
  readonly availableCount: number;
  readonly credits?: ReadonlyArray<{
    readonly status: string;
    readonly expiresAt?: number | null;
  }> | null;
}

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

function isoFromEpochSeconds(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function kindForDuration(mins: number): ServerProviderUsageWindow["kind"] {
  if (mins >= MONTH_MINS) return "monthly";
  if (mins >= WEEK_MINS) return "weekly";
  return "session";
}

function labelForKind(kind: ServerProviderUsageWindow["kind"]): string {
  return kind === "session" ? "Session" : kind === "weekly" ? "Weekly" : "Monthly";
}

/** primary/secondary are positions; without windowDurationMins, paid plans use 5-hour/weekly windows and Free/Go use monthly. */
function codexRateLimitsToWindows(
  snapshot: CodexRateLimitSnapshot,
): ReadonlyArray<ServerProviderUsageWindow> {
  // Keep model-specific limits out of main allowance rows; older CLIs omit limit IDs.
  if (snapshot.limitId && snapshot.limitId !== "codex") return [];
  const isMonthlyPlan = snapshot.planType === "free" || snapshot.planType === "go";
  const positions = [
    ["primary", snapshot.primary, isMonthlyPlan ? MONTH_MINS : SESSION_MINS],
    ["secondary", snapshot.secondary, WEEK_MINS],
  ] as const;
  const windows: ServerProviderUsageWindow[] = [];
  for (const [id, window, fallbackMins] of positions) {
    if (!window || !Number.isFinite(window.usedPercent)) continue;
    const windowDurationMins =
      typeof window.windowDurationMins === "number" ? window.windowDurationMins : fallbackMins;
    const kind = kindForDuration(windowDurationMins);
    const resetsAt = isoFromEpochSeconds(window.resetsAt);
    windows.push({
      id,
      kind,
      label: labelForKind(kind),
      usedPercent: clampPercent(window.usedPercent),
      windowDurationMins,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  const individualLimit = snapshot.individualLimit;
  if (individualLimit && Number.isFinite(individualLimit.remainingPercent)) {
    const resetsAt = isoFromEpochSeconds(individualLimit.resetsAt);
    windows.push({
      id: "individual",
      kind: "monthly",
      label: "Monthly credit limit",
      usedPercent: clampPercent(100 - individualLimit.remainingPercent),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows;
}

function codexResetCreditsToContract(
  summary: CodexResetCreditsSummary | null | undefined,
): ServerProviderResetCredits | undefined {
  if (!summary) return undefined;
  const expiries = (summary.credits ?? [])
    .filter((credit) => credit.status === "available")
    .map((credit) => credit.expiresAt)
    .filter((value): value is number => typeof value === "number");
  const nextExpiresAt =
    expiries.length > 0 ? isoFromEpochSeconds(Math.min(...expiries)) : undefined;
  return {
    availableCount: Math.max(0, summary.availableCount),
    ...(nextExpiresAt ? { nextExpiresAt } : {}),
  };
}

export function codexRateLimitsToLimits(input: {
  readonly snapshot: CodexRateLimitSnapshot;
  readonly rateLimitsByLimitId?:
    | Readonly<Record<string, CodexRateLimitSnapshot>>
    | null
    | undefined;
  readonly resetCredits?: CodexResetCreditsSummary | null | undefined;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const resetCredits = codexResetCreditsToContract(input.resetCredits);
  const windows = codexRateLimitsToWindows(input.rateLimitsByLimitId?.codex ?? input.snapshot);
  return {
    ...makeUsageLimits({
      checkedAt: input.checkedAt,
      windows,
    }),
    ...(resetCredits ? { resetCredits } : {}),
  };
}

export function codexRateLimitsToUpdate(
  snapshot: CodexRateLimitSnapshot,
  previous?: CodexRateLimitSnapshot,
): ProviderUsageLimitsUpdate | undefined {
  const previousWindows = previous ? codexRateLimitsToWindows(previous) : [];
  // Token ticks repeat session-cached limits that may predate an account probe or reset.
  const windows = codexRateLimitsToWindows(snapshot).filter((window) => {
    const existing = previousWindows.find((candidate) => candidate.id === window.id);
    return (
      !existing ||
      existing.kind !== window.kind ||
      existing.usedPercent !== window.usedPercent ||
      existing.resetsAt !== window.resetsAt ||
      existing.windowDurationMins !== window.windowDurationMins
    );
  });
  return windows.length > 0 ? { windows } : undefined;
}

export function codexRateLimitsFailureMessage(error: CodexErrors.CodexAppServerError): string {
  switch (error._tag) {
    case "CodexAppServerRequestError":
      return `Codex could not read usage (JSON-RPC ${error.code}).`;
    case "CodexAppServerSpawnError":
      return "Codex could not be started to read usage.";
    case "CodexAppServerProcessExitedError":
      return "Codex exited before it could report usage.";
    default:
      return "Codex did not answer the usage request.";
  }
}

/** Rate-limit notifications are partial: omitted fields preserve earlier session values. */
export function mergeCodexRateLimits(
  previous: CodexRateLimitSnapshot | undefined,
  update: CodexRateLimitSnapshot,
): CodexRateLimitSnapshot | undefined {
  // Model-specific snapshots must not overwrite the main allowance.
  if (update.limitId && update.limitId !== "codex") return previous;
  if (!previous) return update;
  return {
    ...previous,
    ...(update.limitId !== undefined ? { limitId: update.limitId } : {}),
    ...(update.planType !== undefined ? { planType: update.planType } : {}),
    ...(update.rateLimitReachedType !== undefined
      ? { rateLimitReachedType: update.rateLimitReachedType }
      : {}),
    ...(update.primary !== undefined ? { primary: update.primary } : {}),
    ...(update.secondary !== undefined ? { secondary: update.secondary } : {}),
    ...(update.individualLimit !== undefined ? { individualLimit: update.individualLimit } : {}),
  };
}

/** All exhausted windows must reset before a continuation can run. */
export function parseCodexErrorMessageResetAt(
  message: string | null | undefined,
  nowMs = Date.now(),
): string | null {
  if (!message || typeof message !== "string") return null;

  // Format: "try again at Oct 30th, 2026 12:31 AM" or "try again at Oct 30, 2026 12:31 AM"
  const dateMatch =
    /try again at ([A-Za-z]+ \d{1,2})(?:st|nd|rd|th)?,? (\d{4} \d{1,2}:\d{2}(?::\d{2})? (?:AM|PM))/i.exec(
      message,
    );
  if (dateMatch) {
    const ms = Date.parse(`${dateMatch[1]}, ${dateMatch[2]}`);
    if (Number.isFinite(ms)) {
      const dt = DateTime.make(ms);
      if (Option.isSome(dt)) return DateTime.formatIso(dt.value);
    }
  }

  // Format: "try again at 12:31 AM" (time only, roll over to tomorrow if earlier than now)
  const timeMatch =
    /try again at (\d{1,2}:\d{2}(?::\d{2})? (?:AM|PM))/i.exec(message);
  if (timeMatch) {
    const todayStr = new Date(nowMs).toDateString();
    const candidateMs = Date.parse(`${todayStr} ${timeMatch[1]}`);
    if (Number.isFinite(candidateMs)) {
      const resetMs =
        candidateMs > nowMs ? candidateMs : candidateMs + 24 * 60 * 60 * 1000;
      const dt = DateTime.make(resetMs);
      if (Option.isSome(dt)) return DateTime.formatIso(dt.value);
    }
  }

  // Format: "try again in X hours Y minutes" or "try again after X hours Y minutes"
  const durationMatch =
    /try again (?:in|after) (?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(
      message,
    );
  if (durationMatch && (durationMatch[1] || durationMatch[2])) {
    const hours = parseInt(durationMatch[1] || "0", 10);
    const mins = parseInt(durationMatch[2] || "0", 10);
    const resetMs = nowMs + (hours * 60 + mins) * 60 * 1000;
    const dt = DateTime.make(resetMs);
    if (Option.isSome(dt)) return DateTime.formatIso(dt.value);
  }

  return null;
}

export function codexUsageLimitResetAt(
  snapshot: CodexRateLimitSnapshot | undefined,
  failureMessage?: string | null,
  nowMs = Date.now(),
): string | null {
  if (snapshot) {
    const windows = codexRateLimitsToWindows(snapshot).filter(
      (window) => window.usedPercent >= 100,
    );
    if (windows.length > 0 && windows.every((window) => window.resetsAt)) {
      return windows.reduce<string | null>(
        (latest, window) =>
          latest === null || Date.parse(window.resetsAt!) > Date.parse(latest)
            ? window.resetsAt!
            : latest,
        null,
      );
    }

    // Codex can refuse a turn when the reported percentage lags or sits near quota.
    // Accept near-exhausted windows (>= 99%) whose reset is in the future.
    const nearWindows = codexRateLimitsToWindows(snapshot).filter(
      (window) =>
        window.usedPercent >= 99 &&
        window.resetsAt &&
        Date.parse(window.resetsAt) > nowMs,
    );
    if (nearWindows.length > 0) {
      return nearWindows.reduce<string | null>(
        (latest, window) =>
          latest === null || Date.parse(window.resetsAt!) > Date.parse(latest)
            ? window.resetsAt!
            : latest,
        null,
      );
    }
  }

  // Fallback to error message parsing if the turn failure carried a retry string.
  if (failureMessage) {
    const parsedReset = parseCodexErrorMessageResetAt(failureMessage, nowMs);
    if (parsedReset) {
      // If snapshot has an unexpired window within 2 minutes of the parsed timestamp,
      // prefer the high-precision seconds from the snapshot window.
      if (snapshot) {
        const parsedMs = Date.parse(parsedReset);
        for (const window of codexRateLimitsToWindows(snapshot)) {
          if (
            window.resetsAt &&
            Math.abs(Date.parse(window.resetsAt) - parsedMs) <= 120_000
          ) {
            return window.resetsAt;
          }
        }
      }
      return parsedReset;
    }
  }

  return null;
}
