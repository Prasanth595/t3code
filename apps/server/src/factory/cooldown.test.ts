/**
 * A provider's rate limit as a session's last message says it, and the backoff the pass keeps per
 * model while one lasts.
 */
import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import {
  COOLDOWN_CAP_MS,
  COOLDOWN_QUIET_MS,
  coolingDown,
  forgetQuietCooldowns,
  rateLimitOf,
  recordRateLimit,
  type Cooldown,
} from "./cooldown.ts";

const MINUTE = 60_000;
const T0 = 1_791_380_000_000;

/** What Claude Code ended the sessions of the Trilogy Mac with. */
const CLAUDE_COOLDOWN =
  "API Error: Request rejected (429) · All credentials for model claude-fable-5-1 are cooling down (last error: rate_limit_error: This request would exceed your account's rate limit. Please try again later.)";

describe("rateLimitOf", () => {
  it("reads a 429, a rate_limit_error and a credential cooldown as a rate limit", () => {
    for (const text of [
      CLAUDE_COOLDOWN,
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
      "upstream answered HTTP 429",
      "status 429 Too Many Requests",
      "All credentials for model gpt-5.5 are cooling down",
    ]) {
      assert.deepStrictEqual(rateLimitOf(text), { retryAfterMs: null }, text);
    }
  });

  it("does not read other failures, or a 429 that is only a number, as a rate limit", () => {
    for (const text of [
      null,
      "",
      "it crashed",
      "Working on #429 now",
      "Fixed the 429 handling in the factory, pushed the branch",
      "the build cooled down after the tests",
    ]) {
      assert.strictEqual(rateLimitOf(text), null, String(text));
    }
  });

  it("takes the provider's retry-after, in seconds unless it names a unit", () => {
    assert.deepStrictEqual(rateLimitOf("HTTP 429, retry-after: 120"), { retryAfterMs: 120_000 });
    assert.deepStrictEqual(rateLimitOf("rate_limit_error: retry after 3 minutes"), {
      retryAfterMs: 3 * MINUTE,
    });
    assert.deepStrictEqual(rateLimitOf("rate_limit_error: please try again in 45s"), {
      retryAfterMs: 45_000,
    });
  });
});

describe("recordRateLimit", () => {
  it("backs off exponentially, from 5 minutes up to the cap", () => {
    const cooldowns = new Map<string, Cooldown>();
    let now = T0;
    const lengths: Array<number> = [];
    for (let i = 0; i < 7; i++) {
      // Each session that was resumed after the window ran into the limit again.
      recordRateLimit(
        cooldowns,
        "claudeAgent claude-fable-5-1",
        "claude-fable-5-1",
        now,
        now,
        null,
      );
      const cooldown = cooldowns.get("claudeAgent claude-fable-5-1")!;
      lengths.push(cooldown.untilMs - now);
      assert.strictEqual(cooldown.windows, i + 1);
      now = cooldown.untilMs + MINUTE;
    }
    assert.deepStrictEqual(
      lengths.map((ms) => ms / MINUTE),
      [5, 10, 20, 40, 60, 60, 60],
    );
    assert.strictEqual(COOLDOWN_CAP_MS, 60 * MINUTE);
  });

  it("does not move the window for a session that ended before it was over", () => {
    const cooldowns = new Map<string, Cooldown>();
    recordRateLimit(cooldowns, "k", "m", T0, T0, null);
    const first = cooldowns.get("k")!;
    // Nine more sessions of the same burst, read in the same pass and the next.
    for (let i = 1; i < 10; i++) recordRateLimit(cooldowns, "k", "m", T0 + i, T0 + MINUTE, null);
    assert.deepStrictEqual(cooldowns.get("k"), first);
  });

  it("uses the provider's retry-after for the window when it gives one", () => {
    const cooldowns = new Map<string, Cooldown>();
    recordRateLimit(cooldowns, "k", "m", T0, T0, 90 * MINUTE);
    assert.strictEqual(cooldowns.get("k")!.untilMs, T0 + 90 * MINUTE);
  });

  it("keeps each model's window apart", () => {
    const cooldowns = new Map<string, Cooldown>();
    recordRateLimit(cooldowns, "a", "model-a", T0, T0, null);
    assert.isNotNull(coolingDown(cooldowns, "a", T0 + MINUTE));
    assert.isNull(coolingDown(cooldowns, "b", T0 + MINUTE));
  });
});

describe("coolingDown and forgetQuietCooldowns", () => {
  it("is cooling only until the window ends", () => {
    const cooldowns = new Map<string, Cooldown>();
    recordRateLimit(cooldowns, "k", "m", T0, T0, null);
    assert.isNotNull(coolingDown(cooldowns, "k", T0 + 5 * MINUTE - 1));
    assert.isNull(coolingDown(cooldowns, "k", T0 + 5 * MINUTE));
  });

  it("forgets a model once it has been quiet past its window, so the next limit starts over", () => {
    const cooldowns = new Map<string, Cooldown>();
    recordRateLimit(cooldowns, "k", "m", T0, T0, null);
    const until = cooldowns.get("k")!.untilMs;
    assert.deepStrictEqual(forgetQuietCooldowns(cooldowns, until + COOLDOWN_QUIET_MS - 1), []);
    assert.deepStrictEqual(forgetQuietCooldowns(cooldowns, until + COOLDOWN_QUIET_MS), ["k"]);
    assert.strictEqual(cooldowns.size, 0);
    const later = until + COOLDOWN_QUIET_MS + MINUTE;
    recordRateLimit(cooldowns, "k", "m", later, later, null);
    assert.strictEqual(cooldowns.get("k")!.windows, 1);
  });
});
