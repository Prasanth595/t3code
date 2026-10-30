import { field } from "../unknownField.ts";
import * as DateTime from "effect/DateTime";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

export function claudeGatewayQuotaFailure(input: {
  readonly result: string;
  readonly status: number | null | undefined;
  readonly completedAt: DateTime.Utc;
  readonly previousAttempts: unknown;
  readonly identity: string;
}) {
  if (input.status !== 429 && input.status !== 503) return null;
  const body = /^API Error: (?:429|503)\s+([\s\S]+)$/.exec(input.result)?.[1];
  if (body === undefined) return null;
  let code: unknown;
  let reset: unknown;
  let retryAfter: unknown;
  try {
    const parsed: unknown = JSON.parse(body);
    const error = field(parsed, "error") ?? parsed;
    code = field(error, "code");
    const message = field(error, "message");
    if (code === undefined && typeof message === "string") {
      code = /^(claude_quota_exhausted|claude_quota_unavailable):/.exec(message)?.[1];
    }
    if (field(error, "retryable") === false) return null;
    reset = field(error, "reset_at");
    retryAfter = field(error, "retry_after_seconds");
  } catch {
    code = /^(claude_quota_exhausted|claude_quota_unavailable):/.exec(body)?.[1];
  }
  if (code !== "claude_quota_exhausted" && code !== "claude_quota_unavailable") return null;
  const now = DateTime.toEpochMillis(input.completedAt);
  const resetMs = typeof reset === "string" ? Date.parse(reset) : NaN;
  const attempts =
    typeof input.previousAttempts === "number" && Number.isSafeInteger(input.previousAttempts)
      ? Math.max(0, Math.min(4, input.previousAttempts))
      : 0;
  const delay = Math.min(750, 60 * 2 ** attempts);
  // Stable jitter keeps a persisted retry unchanged across process restarts.
  const hash = Array.from(input.identity).reduce(
    (value, char) => (value * 31 + char.charCodeAt(0)) >>> 0,
    0,
  );
  const seconds =
    typeof retryAfter === "number" &&
    Number.isFinite(retryAfter) &&
    retryAfter > 0 &&
    retryAfter <= 604_800
      ? retryAfter
      : delay + (hash % (Math.floor(delay / 5) + 1));
  return makeProviderFailure({
    class: "usage_limit",
    code,
    retryable: true,
    message:
      code === "claude_quota_exhausted"
        ? "Waiting for Claude quota."
        : "Waiting for Claude quota availability to refresh.",
    ...(Number.isFinite(resetMs) && resetMs > now && resetMs <= 253402300799000
      ? { resetAt: DateTime.formatIso(DateTime.makeUnsafe(resetMs)) }
      : { retryAt: DateTime.formatIso(DateTime.makeUnsafe(now + seconds * 1_000)) }),
  });
}
