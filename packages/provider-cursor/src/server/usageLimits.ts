import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import type { CursorSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CURSOR_USAGE_WINDOWS } from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as Result from "effect/Result";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type { CursorCredentialState } from "./auth.ts";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as CursorKeychain from "./CursorKeychain.ts";

const CursorCredentials = Schema.Struct({ accessToken: Schema.optional(Schema.String) });
const DEFAULT_CURSOR_API_ENDPOINT = "https://api2.cursor.sh";
const decodeCredentials = Schema.decodeEffect(Schema.fromJsonString(CursorCredentials));
const CursorUsageResponse = Schema.Struct({
  billingCycleEnd: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  planUsage: Schema.optional(
    Schema.Struct({
      totalPercentUsed: Schema.optional(Schema.Number),
      autoPercentUsed: Schema.optional(Schema.Number),
      apiPercentUsed: Schema.optional(Schema.Number),
    }),
  ),
});

/** Cursor's dashboard percentages include bonus usage; spend / limit does not. */
export function cursorUsageResponseToLimits(
  response: typeof CursorUsageResponse.Type,
  checkedAt: string,
) {
  const reset = DateTime.make(Number(response.billingCycleEnd));
  const resetsAt =
    Number(response.billingCycleEnd) > 0 && Option.isSome(reset)
      ? DateTime.formatIso(reset.value)
      : undefined;
  const windows: ServerProviderUsageWindow[] = [];
  if (response.planUsage) {
    for (const { id, label } of CURSOR_USAGE_WINDOWS) {
      const usedPercent = response.planUsage[id];
      if (usedPercent === undefined || !Number.isFinite(usedPercent)) continue;
      windows.push({
        id,
        kind: "monthly",
        label,
        usedPercent: clampPercent(usedPercent),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
}

interface UsageToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}
const tokens = new Map<string, UsageToken>();
const exchanges = new Map<
  string,
  Effect.Effect<
    UsageToken | undefined,
    Effect.Error<ReturnType<typeof exchangeToken>>,
    HttpClient.HttpClient
  >
>();

function pruneCursorUsageTokens(instanceId: string, keepKey?: string): void {
  for (const entries of [tokens, exchanges]) {
    for (const existing of entries.keys()) {
      if (existing.startsWith(`${instanceId.length}:${instanceId}:`) && existing !== keepKey)
        entries.delete(existing);
    }
  }
}

const decodeTokenClaims = Schema.decodeOption(
  Schema.fromJsonString(Schema.Struct({ exp: Schema.Number })),
);

function tokenExpiresAt(accessToken: string, now: number): number {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return now + 300_000;
  const decoded = Base64Url.decodeString(parts[1]!);
  if (Result.isFailure(decoded)) return now + 300_000;
  // JWT claims only bound the cache lifetime; the backend validates the bearer.
  const claims = decodeTokenClaims(decoded.success);
  if (Option.isSome(claims)) {
    const expiresAtMs = claims.value.exp * 1000 - 60_000;
    if (Number.isFinite(expiresAtMs)) return expiresAtMs;
  }
  return now + 300_000;
}

const exchangeToken = (endpoint: string, apiKey: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(`${endpoint}/auth/exchange_user_api_key`).pipe(
        HttpClientRequest.bearerToken(apiKey),
        HttpClientRequest.bodyJsonUnsafe({}),
      ),
    );
    if (response.status === 401) return undefined;
    const body = yield* HttpClientResponse.schemaBodyJson(
      Schema.Struct({ accessToken: Schema.NonEmptyString }),
    )(yield* HttpClientResponse.filterStatusOk(response));
    return {
      accessToken: body.accessToken,
      expiresAtMs: tokenExpiresAt(body.accessToken, yield* Clock.currentTimeMillis),
    };
  });

const getInstanceToken = (key: string, endpoint: string, apiKey: string) =>
  Effect.gen(function* () {
    const pending = exchanges.get(key);
    if (pending) return yield* pending;
    const operation = yield* Effect.cached(
      exchangeToken(endpoint, apiKey).pipe(
        Effect.tap((token) =>
          Effect.sync(() => {
            // A rotated or logged-out instance must not be repopulated by an older exchange.
            if (token && exchanges.get(key) === operation) tokens.set(key, token);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (exchanges.get(key) === operation) exchanges.delete(key);
          }),
        ),
      ),
    );
    exchanges.set(key, operation);
    return yield* operation;
  });

const readInstanceUsage = (
  instanceId: string,
  credential: CursorCredentialState,
  checkedAt: string,
) =>
  Effect.gen(function* () {
    if (credential.status !== "valid") pruneCursorUsageTokens(instanceId);
    const authRequired = () =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Cursor sign-in expired or was rejected. Sign in again in provider settings.",
      });
    if (credential.status === "absent") return undefined;
    if (credential.status === "expired") return authRequired();
    const endpoint = yield* Effect.try(() => {
      const url = new URL(credential.backendUrl);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Invalid Cursor credential backend.");
      return url.origin;
    });
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(credential.apiKey));
    const key = `${instanceId.length}:${instanceId}:${endpoint}:${Hex.encode(digest)}`;
    pruneCursorUsageTokens(instanceId, key);
    const now = yield* Clock.currentTimeMillis;
    const cached = tokens.get(key);
    const usable = cached && cached.expiresAtMs > now ? cached : undefined;
    if (!usable) tokens.delete(key);
    let token = usable ?? (yield* getInstanceToken(key, endpoint, credential.apiKey));
    if (!token) return authRequired();
    const client = yield* HttpClient.HttpClient;
    const requestUsage = (accessToken: string) =>
      client.execute(
        HttpClientRequest.post(
          `${endpoint}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`,
        ).pipe(
          HttpClientRequest.bearerToken(accessToken),
          HttpClientRequest.setHeaders({
            "connect-protocol-version": "1",
            "x-cursor-client-type": "sdk",
          }),
          HttpClientRequest.bodyJsonUnsafe({}),
        ),
      );
    let response = yield* requestUsage(token.accessToken);
    if (response.status === 401) {
      if (tokens.get(key) === token) tokens.delete(key);
      if (usable) {
        token = yield* getInstanceToken(key, endpoint, credential.apiKey);
        if (!token) return authRequired();
        response = yield* requestUsage(token.accessToken);
        if (response.status === 401 && tokens.get(key) === token) tokens.delete(key);
      }
    }
    const body = yield* HttpClientResponse.schemaBodyJson(CursorUsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return cursorUsageResponseToLimits(body, checkedAt);
  }).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }));

export const readCursorUsageLimits = Effect.fn("readCursorUsageLimits")(function* (
  settings: Pick<CursorSettings, "apiEndpoint">,
  environment: NodeJS.ProcessEnv = process.env,
  allowKeychain = false,
  instance?: { readonly instanceId: string; readonly credential: CursorCredentialState },
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.gen(function* () {
    if (instance) {
      const limits = yield* readInstanceUsage(instance.instanceId, instance.credential, checkedAt);
      if (limits) return limits;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const endpoint = (
      settings.apiEndpoint?.trim() ||
      environment.CURSOR_API_ENDPOINT?.trim() ||
      DEFAULT_CURSOR_API_ENDPOINT
    ).replace(/\/$/, "");
    let token = environment.CURSOR_AUTH_TOKEN?.trim();
    // An explicit API key can name a different account from the stored login.
    if (!token && environment.CURSOR_API_KEY?.trim()) {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    const credentialStore = environment.AGENT_CLI_CREDENTIAL_STORE;
    if (!token && credentialStore === "memory") {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Cursor usage requires a CLI login or CURSOR_AUTH_TOKEN.",
      });
    }
    if (!token && platform === "darwin" && credentialStore !== "file") {
      if (!allowKeychain) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "Enable Cursor account usage in T3 Code to read its Keychain login.",
        });
      }
      if (endpoint !== DEFAULT_CURSOR_API_ENDPOINT) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "Cursor account usage requires the default Cursor endpoint when using Keychain.",
        });
      }
      const keychain = yield* CursorKeychain.CursorKeychain;
      token = (yield* keychain.accessToken)?.trim();
    } else if (!token) {
      const home =
        (platform === "win32" ? environment.USERPROFILE : environment.HOME) ||
        (yield* HostProcess.HomeDirectory);
      const directory =
        platform === "win32"
          ? path.join(environment.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor")
          : platform === "darwin"
            ? path.join(home, ".cursor")
            : path.join(environment.XDG_CONFIG_HOME || path.join(home, ".config"), "cursor");
      const credentials = yield* fs.readFileString(path.join(directory, "auth.json")).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
        }),
        Effect.flatMap(decodeCredentials),
      );
      token = credentials.accessToken?.trim();
    }
    if (!token) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(`${endpoint}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeaders({
          "connect-protocol-version": "1",
          "x-cursor-client-type": "cli",
        }),
        HttpClientRequest.bodyJsonUnsafe({}),
      ),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(CursorUsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return cursorUsageResponseToLimits(body, checkedAt);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Cursor could not read usage limits.",
      }),
    ),
  );
});
