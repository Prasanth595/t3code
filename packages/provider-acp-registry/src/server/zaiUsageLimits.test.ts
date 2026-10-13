import { sha256 } from "@noble/hashes/sha2";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { readZaiUsageLimits, zaiUsageResponseToLimits } from "./zaiUsageLimits.ts";

const CHECKED_AT = "2026-10-13T12:00:00.000Z";
const API_KEY = "rate-test-key";

/** Digests with the real SHA-256 so the fingerprint is the one production computes. */
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (algorithm, data) =>
    algorithm === "SHA-256" ? Effect.succeed(sha256(data)) : Effect.die(algorithm),
});

/** The live shape of a Lite credit plan, as the endpoint returned it. */
const CREDIT_PLAN = {
  code: 200,
  msg: "Operation successful",
  success: true,
  data: {
    level: "lite",
    limits: [
      {
        type: "CREDIT_LIMIT",
        unit: 3,
        number: 5,
        usage: 2000,
        currentValue: 1450,
        remaining: 549,
        percentage: 72,
        nextResetTime: 1791920097643,
      },
      {
        type: "CREDIT_LIMIT",
        unit: 6,
        number: 1,
        usage: 10000,
        currentValue: 5470,
        remaining: 4529,
        percentage: 54,
        nextResetTime: 1791983710979,
      },
    ],
  },
};

describe("zaiUsageResponseToLimits", () => {
  it("maps the credit plan's 5-hour and weekly windows with their resets", () => {
    const limits = zaiUsageResponseToLimits(CREDIT_PLAN, CHECKED_AT);
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([
      {
        id: "glm_session",
        kind: "session",
        label: "GLM · Session",
        usedPercent: 72,
        windowDurationMins: 300,
        resetsAt: "2026-10-13T19:34:57.643Z",
      },
      {
        id: "glm_weekly",
        kind: "weekly",
        label: "GLM · Weekly",
        usedPercent: 54,
        windowDurationMins: 10080,
        resetsAt: "2026-10-14T13:15:10.979Z",
      },
    ]);
  });

  it("maps the monthly tool quota and keeps a window the plan leaves without a reset", () => {
    const limits = zaiUsageResponseToLimits(
      {
        success: true,
        data: {
          level: "pro",
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 12 },
            { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 33 },
            {
              type: "TIME_LIMIT",
              unit: 5,
              number: 1,
              usage: 1000,
              currentValue: 250,
              percentage: 25,
            },
            // A dimension T3 has no bucket for is left out, not shown empty.
            { type: "TOKENS_LIMIT", unit: 1, number: 1, percentage: 50 },
          ],
        },
      },
      CHECKED_AT,
    );
    expect(limits.windows).toEqual([
      {
        id: "glm_session",
        kind: "session",
        label: "GLM · Session",
        usedPercent: 12,
        windowDurationMins: 300,
      },
      {
        id: "glm_weekly",
        kind: "weekly",
        label: "GLM · Weekly",
        usedPercent: 33,
        windowDurationMins: 10080,
      },
      { id: "glm_monthly", kind: "monthly", label: "GLM · Monthly", usedPercent: 25 },
    ]);
  });

  it("derives a percentage from the counters when the plan omits it, first entry winning", () => {
    const limits = zaiUsageResponseToLimits(
      {
        success: true,
        data: {
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 1000 },
            { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 99 },
          ],
        },
      },
      CHECKED_AT,
    );
    expect(limits.windows).toEqual([
      {
        id: "glm_session",
        kind: "session",
        label: "GLM · Session",
        usedPercent: 50,
        windowDurationMins: 300,
      },
    ]);
  });

  it("treats a missing or empty plan as an account without limits", () => {
    for (const response of [
      { success: false },
      { success: true, data: { level: "pro", limits: [] } },
    ]) {
      const limits = zaiUsageResponseToLimits(response, CHECKED_AT);
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.reason).toBe("unsupported");
    }
  });
});

describe("readZaiUsageLimits", () => {
  it.effect("reads the quota with the instance's own key and fingerprints the credential", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) => {
        expect(request.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
        expect(request.headers.authorization).toBe(API_KEY);
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(CREDIT_PLAN)));
      });
      const limits = yield* readZaiUsageLimits({
        environment: { Z_AI_API_KEY: ` ${API_KEY} ` },
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));

      expect(limits?.windows.map((window) => window.id)).toEqual(["glm_session", "glm_weekly"]);
      expect(limits?.credentialFingerprint).toBe(
        Hex.encode(sha256(new TextEncoder().encode(`Z_AI_API_KEY\0${API_KEY}`))),
      );
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)),
  );

  it.effect("publishes nothing without a key and reports a failed read as a probe failure", () =>
    Effect.gen(function* () {
      const keyless = yield* readZaiUsageLimits({ environment: {} }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("a keyless instance must not call the quota endpoint")),
        ),
      );
      expect(keyless).toBeNull();

      const failed = yield* readZaiUsageLimits({
        environment: { Z_AI_API_KEY: API_KEY },
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status: 500 }))),
          ),
        ),
      );
      expect(failed?.windows).toEqual([]);
      expect(failed?.unavailable?.reason).toBe("probeFailed");
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)),
  );
});
