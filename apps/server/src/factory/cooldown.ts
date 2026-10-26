/**
 * A provider's rate limit, as a session's last message says it, and the backoff the pass keeps per
 * model while one lasts. A rate limit is the provider's, not the issue's: the pass holds back the
 * claims that would run into it and resumes the session once it is over (`pass.ts`).
 */
import type { Model } from "./t3/sessions.ts";

/** What a session that ended on a rate limit said about it. */
export interface RateLimit {
  /** How long the provider asked to wait, when it said; null for no word. */
  readonly retryAfterMs: number | null;
}

/** One model's rate limit: until when it cools down, and how many windows in a row it has hit. */
export interface Cooldown {
  readonly model: string;
  untilMs: number;
  windows: number;
  /** The streak's attention item was raised: it is raised once per streak. */
  raised: boolean;
}

/** The first window. Each window the model is hit again after the last one ended is twice as long. */
const COOLDOWN_FIRST_MS = 5 * 60_000;
/** The longest window the factory picks itself. A provider's retry-after is taken as it is. */
export const COOLDOWN_CAP_MS = 60 * 60_000;
/** How long after its window a model that was not hit again starts over at the first window. */
export const COOLDOWN_QUIET_MS = 30 * 60_000;

/**
 * Claude Code's `Request rejected (429)` and `rate_limit_error`, an HTTP 429 or a 429 status said
 * as such, and the credential pool's `All credentials for model … are cooling down`. A bare 429
 * (an issue number, a commit message) is not one.
 */
const RATE_LIMITED =
  /rate_limit_error|\((?:HTTP )?429\)|\bHTTP 429\b|\b(?:status|error|code) 429\b|\b429 Too Many Requests\b|\bAPI Error: 429\b|credentials for model \S+ are cooling down/i;

/** `retry-after: 120`, `retry after 3 minutes`, `try again in 45s`; seconds unless a unit is named. */
const RETRY_AFTER =
  /(?:retry[- ]after:?|try again in)\s*(\d+)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)?\b/i;

const UNIT_MS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^ms|^millisecond/i, 1],
  [/^h/i, 3_600_000],
  [/^m/i, 60_000],
];

/** The rate limit `text` (a session's last message) reports, or null for none. */
export const rateLimitOf = (text: string | null): RateLimit | null => {
  if (text === null || !RATE_LIMITED.test(text)) return null;
  const after = RETRY_AFTER.exec(text);
  if (after === null) return { retryAfterMs: null };
  const unit = after[2] ?? "s";
  const ms = UNIT_MS.find(([pattern]) => pattern.test(unit))?.[1] ?? 1000;
  return { retryAfterMs: Number(after[1]) * ms };
};

/** How a model is named in the cooldowns, the pass's lines and its attention item. */
export const cooldownKey = (model: Model): string => `${model.instanceId} ${model.model}`;

/**
 * Records that a session on `model` ended on a rate limit at `endedMs`, seen at `nowMs`. A session
 * that ended inside the current window is part of the burst that opened it and changes nothing.
 * Otherwise a window opens from now: the provider's retry-after, else 5 minutes doubling each
 * window in a row up to `COOLDOWN_CAP_MS`.
 */
export const recordRateLimit = (
  cooldowns: Map<string, Cooldown>,
  key: string,
  model: string,
  endedMs: number,
  nowMs: number,
  retryAfterMs: number | null,
): void => {
  const current = cooldowns.get(key);
  if (current !== undefined && endedMs < current.untilMs) return;
  const windows = (current?.windows ?? 0) + 1;
  const backoff = Math.min(COOLDOWN_FIRST_MS * 2 ** (windows - 1), COOLDOWN_CAP_MS);
  const untilMs = nowMs + (retryAfterMs ?? backoff);
  if (current === undefined) {
    cooldowns.set(key, { model, untilMs, windows, raised: false });
  } else {
    current.untilMs = untilMs;
    current.windows = windows;
  }
};

/** The model's cooldown while its window lasts; null once it is over or for none. */
export const coolingDown = (
  cooldowns: ReadonlyMap<string, Cooldown>,
  key: string,
  nowMs: number,
): Cooldown | null => {
  const cooldown = cooldowns.get(key);
  return cooldown !== undefined && nowMs < cooldown.untilMs ? cooldown : null;
};

/** Drops each model that has gone `COOLDOWN_QUIET_MS` past its window, and answers their keys. */
export const forgetQuietCooldowns = (
  cooldowns: Map<string, Cooldown>,
  nowMs: number,
): Array<string> => {
  const quiet = [...cooldowns]
    .filter(([, cooldown]) => nowMs >= cooldown.untilMs + COOLDOWN_QUIET_MS)
    .map(([key]) => key);
  for (const key of quiet) cooldowns.delete(key);
  return quiet;
};

/**
 * The model a session started or resumed now runs on: `model` while it does not cool down, else its
 * `fallbacks` model on the same provider instance, with the same options, while that one does not
 * cool down. Null while `model` cools down with no fallback free.
 */
export const launchModel = (
  cooldowns: ReadonlyMap<string, Cooldown>,
  fallbacks: Readonly<Record<string, string>>,
  model: Model,
  nowMs: number,
): Model | null => {
  if (coolingDown(cooldowns, cooldownKey(model), nowMs) === null) return model;
  const to = Object.hasOwn(fallbacks, model.model) ? fallbacks[model.model] : undefined;
  if (to === undefined) return null;
  const fallback: Model = { ...model, model: to };
  return coolingDown(cooldowns, cooldownKey(fallback), nowMs) === null ? fallback : null;
};
