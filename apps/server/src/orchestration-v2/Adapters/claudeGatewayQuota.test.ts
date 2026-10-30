import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { claudeGatewayQuotaFailure } from "./claudeGatewayQuota.ts";

const completedAt = DateTime.makeUnsafe("2026-10-29T12:00:00Z");
const nowMs = DateTime.toEpochMillis(completedAt);
const parse = (error: unknown, previousAttempts: unknown = 0) =>
  claudeGatewayQuotaFailure({
    result: `API Error: 429 ${JSON.stringify({ error })}`,
    status: 429,
    completedAt,
    previousAttempts,
    identity: "run-1",
  });

describe("claudeGatewayQuotaFailure", () => {
  it.each([
    { reset_at: "2026-10-29T13:00:00Z", expectedReset: "2026-10-29T13:00:00.000Z" },
    { reset_at: "expired", retry_after_seconds: 120, expectedDelay: 120 },
    { reset_at: "2026-10-29T11:00:00Z", retry_after_seconds: 90, expectedDelay: 90 },
    { retry_after_seconds: 300, expectedDelay: 300 },
  ])("separates known resets from retry deadlines ($reset_at)", (input) => {
    const failure = parse({ code: "claude_quota_exhausted", retryable: true, ...input });
    expect(failure?.code).toBe("claude_quota_exhausted");
    if (input.expectedReset) {
      expect(failure?.resetAt).toBe(input.expectedReset);
      expect(failure?.retryAt).toBeUndefined();
    } else {
      expect(failure?.resetAt).toBeUndefined();
      expect(Date.parse(failure!.retryAt!) - nowMs).toBe(input.expectedDelay! * 1_000);
    }
  });

  it.each([0, 1, 4, 5, 100, -1, "invalid", NaN])(
    "bounds fallback backoff for %s attempts",
    (attempts) => {
      const error = { code: "claude_quota_unavailable", retry_after_seconds: -1 };
      const failure = parse(error, attempts);
      const delay = Date.parse(failure!.retryAt!) - nowMs;
      expect(delay).toBeGreaterThanOrEqual(60_000);
      expect(delay).toBeLessThanOrEqual(900_000);
      expect(parse(error, attempts)).toEqual(failure);
      if (attempts === 1)
        expect(delay).toBeGreaterThan(Date.parse(parse(error, 0)!.retryAt!) - nowMs);
    },
  );

  it.each([
    { code: "authentication_failed" },
    { code: "claude_quota_exhausted", retryable: false },
    { message: "An unrelated error mentions claude_quota_exhausted" },
    null,
  ])("leaves unrelated or non-retryable errors unchanged (%j)", (error) => {
    expect(parse(error)).toBeNull();
  });
});
