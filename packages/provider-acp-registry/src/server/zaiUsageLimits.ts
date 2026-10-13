/**
 * GLM Coding Plan quota for ACP instances.
 *
 * ACP has no subscription-quota channel, so an instance that runs GLM turns
 * reports nothing on Usage -> Limits. When the instance's environment carries
 * a Z.ai API key, this reads the Coding Plan quota from the same read-only
 * endpoint ZCode's own usage view uses. No key means the instance has no
 * quota to report and publishes no limits at all, so the pooled view leaves
 * it out instead of drawing an empty row.
 *
 * @module provider-acp-registry/server/zaiUsageLimits
 */

import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

/** The variable the GLM ACP agent reads, and the only opt-in this probe uses. */
const API_KEY_VARIABLE = "Z_AI_API_KEY";

const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const HOUR_MINUTES = 60;
const WEEK_MINUTES = 7 * 24 * HOUR_MINUTES;

/**
 * The window dimensions ZCode documents: `number` of `unit`, where 3 is
 * hours, 6 is weeks and 5 is months. Token- and credit-based plans report the
 * same prompt windows under different types, and TIME_LIMIT is the monthly
 * tool quota.
 */
const WINDOW_SHAPES = {
  tokens_session: { id: "glm_session", kind: "session", label: "GLM · Session" },
  tokens_weekly: { id: "glm_weekly", kind: "weekly", label: "GLM · Weekly" },
  time_monthly: { id: "glm_monthly", kind: "monthly", label: "GLM · Monthly" },
} as const satisfies Record<
  string,
  { readonly id: string; readonly kind: ServerProviderUsageWindow["kind"]; readonly label: string }
>;

const UsageLimit = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  unit: Schema.optionalKey(Schema.Finite),
  number: Schema.optionalKey(Schema.Finite),
  percentage: Schema.optionalKey(Schema.Finite),
  usage: Schema.optionalKey(Schema.Finite),
  currentValue: Schema.optionalKey(Schema.Finite),
  nextResetTime: Schema.optionalKey(Schema.Finite),
});
const UsageResponse = Schema.Struct({
  success: Schema.optionalKey(Schema.Boolean),
  data: Schema.optionalKey(
    Schema.Struct({
      level: Schema.optionalKey(Schema.String),
      limits: Schema.optionalKey(Schema.Array(UsageLimit)),
    }),
  ),
});

type UsageLimit = typeof UsageLimit.Type;

/** The bucket a limit entry names, or null for one T3 has no place for. */
function windowShape(limit: UsageLimit) {
  if (limit.type === "TIME_LIMIT") {
    return limit.unit === 5 ? WINDOW_SHAPES.time_monthly : null;
  }
  if (limit.type !== "TOKENS_LIMIT" && limit.type !== "CREDIT_LIMIT") return null;
  if (limit.unit === 3) return WINDOW_SHAPES.tokens_session;
  return limit.unit === 6 ? WINDOW_SHAPES.tokens_weekly : null;
}

/**
 * ZCode says a missing reset hides the reset, not the row, and a plan with no
 * recognizable entry is not an error: a Team Plan key reports its level with
 * an empty list.
 */
function toWindow(limit: UsageLimit, shape: (typeof WINDOW_SHAPES)[keyof typeof WINDOW_SHAPES]) {
  const percent =
    limit.percentage !== undefined && Number.isFinite(limit.percentage)
      ? limit.percentage
      : limit.usage !== undefined && limit.usage > 0 && limit.currentValue !== undefined
        ? (limit.currentValue / limit.usage) * 100
        : null;
  if (percent === null) return null;
  const reset =
    limit.nextResetTime === undefined ? Option.none() : DateTime.make(limit.nextResetTime);
  const duration =
    shape.kind === "session"
      ? (limit.number ?? 1) * HOUR_MINUTES
      : shape.kind === "weekly"
        ? (limit.number ?? 1) * WEEK_MINUTES
        : undefined;
  return {
    id: shape.id,
    kind: shape.kind,
    label: shape.label,
    usedPercent: clampPercent(percent),
    ...(duration === undefined ? {} : { windowDurationMins: duration }),
    ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
  } satisfies ServerProviderUsageWindow;
}

/** Maps a quota response to the windows the pooled Limits view draws. */
export function zaiUsageResponseToLimits(
  response: typeof UsageResponse.Type,
  checkedAt: string,
): ServerProviderUsageLimits {
  if (response.success === false) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "This account has no GLM Coding Plan.",
    });
  }
  const windows: ServerProviderUsageWindow[] = [];
  for (const limit of response.data?.limits ?? []) {
    const shape = windowShape(limit);
    if (shape === null || windows.some((window) => window.id === shape.id)) continue;
    const window = toWindow(limit, shape);
    if (window !== null) windows.push(window);
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "This GLM Coding Plan reports no quota.",
      });
}

/**
 * The Coding Plan quota an instance's own Z.ai key can read, or null when the
 * environment carries no key. A failed read keeps the instance usable and
 * reports a probe failure rather than a missing plan.
 */
export const readZaiUsageLimits = Effect.fn("readZaiUsageLimits")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
}): Effect.fn.Return<
  ServerProviderUsageLimits | null,
  never,
  HttpClient.HttpClient | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const apiKey = input.environment[API_KEY_VARIABLE]?.trim();
  if (!apiKey) return null;
  return yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(QUOTA_URL).pipe(
        // ZCode sends the bare key; the global host also accepts a bearer
        // token, but the bare header is what the endpoint documents.
        HttpClientRequest.setHeaders({ authorization: apiKey }),
      ),
    );
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(UsageResponse)),
    );
    const limits = zaiUsageResponseToLimits(body, checkedAt);
    const crypto = yield* Crypto.Crypto;
    // The response names no account, so one key must match across
    // environments to pool one subscription once.
    const credentialFingerprint = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(`${API_KEY_VARIABLE}\0${apiKey}`))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
    return { ...limits, credentialFingerprint };
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "GLM Coding Plan could not read usage.",
      }),
    ),
  );
});
