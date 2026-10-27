import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

const Credentials = Schema.Struct({ z_ai_api_key: Schema.String });
const decodeCredentials = Schema.decodeOption(Schema.fromJsonString(Credentials));
const QuotaResponse = Schema.Struct({
  code: Schema.optionalKey(Schema.Literal(200)),
  success: Schema.optionalKey(Schema.Literal(true)),
  data: Schema.Struct({ limits: Schema.Array(Schema.Unknown) }),
});
const QuotaKind = Schema.Struct({
  type: Schema.String,
  unit: Schema.optionalKey(Schema.Finite),
  number: Schema.optionalKey(Schema.Finite),
});
const decodeQuotaKind = Schema.decodeUnknownOption(QuotaKind);
const QuotaUsage = Schema.Struct({
  percentage: Schema.Finite,
  nextResetTime: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
});
const decodeQuotaUsage = Schema.decodeUnknownEffect(QuotaUsage);

function monitorOrigin(environment: NodeJS.ProcessEnv): string | undefined {
  try {
    const url = new URL(environment.ACP_GLM_BASE_URL ?? "https://api.z.ai/api/coding/paas/v4");
    if (
      !["https://api.z.ai", "https://open.bigmodel.cn", "https://dev.bigmodel.cn"].includes(
        url.origin,
      ) ||
      url.pathname.replace(/\/+$/, "") !== "/api/coding/paas/v4" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

const readCredential = Effect.fn("GlmUsageLimits.readCredential")(function* (
  environment: NodeJS.ProcessEnv,
) {
  if (environment.Z_AI_API_KEY) return environment.Z_AI_API_KEY;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configHome =
    environment.XDG_CONFIG_HOME ||
    path.join(
      environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory),
      ".config",
    );
  const contents = yield* fs
    .readFileString(path.join(configHome, "glm-acp-agent", "credentials.json"))
    .pipe(Effect.orElseSucceed(() => ""));
  const credentials = decodeCredentials(contents);
  return Option.isSome(credentials) ? credentials.value.z_ai_api_key || undefined : undefined;
});

export const readGlmUsageLimits = Effect.fn("GlmUsageLimits.read")(function* (input: {
  readonly enabled: boolean;
  readonly environment: NodeJS.ProcessEnv;
}) {
  if (!input.enabled) return undefined;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  const origin = monitorOrigin(input.environment);
  if (!origin) return unsupported;
  const key = yield* readCredential(input.environment);
  if (!key) return unsupported;
  const crypto = yield* Crypto.Crypto;
  const credentialFingerprint = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(`glm\0${origin}\0${key}`))
    .pipe(Effect.map(Hex.encode), Effect.orDie);
  return yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    // Z.ai's official usage plugin sends the raw Coding Plan key, without Bearer.
    const response = yield* client
      .execute(
        HttpClientRequest.get(`${origin}/api/monitor/usage/quota/limit`).pipe(
          HttpClientRequest.setHeader("Authorization", key),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(QuotaResponse)),
      );
    const windows: ServerProviderUsageWindow[] = [];
    for (const entry of response.data.limits) {
      const decoded = decodeQuotaKind(entry);
      if (Option.isNone(decoded)) continue;
      const quota = decoded.value;
      const tokens = quota.type === "TOKENS_LIMIT" || quota.type === "CREDIT_LIMIT";
      const window =
        tokens && quota.unit === 3 && quota.number === 5
          ? ({
              id: "glm_session",
              kind: "session",
              label: "Session",
              windowDurationMins: 300,
            } as const)
          : tokens && quota.unit === 6 && quota.number === 1
            ? ({
                id: "glm_weekly",
                kind: "weekly",
                label: "Weekly",
                windowDurationMins: 10080,
              } as const)
            : quota.type === "TIME_LIMIT" && quota.unit === 5 && quota.number === 1
              ? ({ id: "glm_mcp_monthly", kind: "monthly", label: "MCP tools · Monthly" } as const)
              : undefined;
      if (!window) continue;
      const usage = yield* decodeQuotaUsage(entry);
      const reset =
        usage.nextResetTime && usage.nextResetTime > 0
          ? DateTime.make(usage.nextResetTime)
          : Option.none();
      windows.push({
        ...window,
        usedPercent: clampPercent(usage.percentage),
        ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
      });
    }
    if (windows.length === 0) return unsupported;
    return { ...makeUsageLimits({ checkedAt, windows }), credentialFingerprint };
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() => ({
      ...makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "GLM Agent could not read usage.",
      }),
      credentialFingerprint,
    })),
  );
});
