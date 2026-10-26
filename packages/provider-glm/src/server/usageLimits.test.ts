import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { readGlmUsageLimits } from "./usageLimits.ts";

const enabled = true;
const session = { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 42 };
const quota = (limits: ReadonlyArray<unknown>) => ({ code: 200, success: true, data: { limits } });
const responseClient = (body: unknown, status = 200) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
  );
const withServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(HostProcess.HomeDirectory, "/unused-glm-test-home"),
  );

describe("GLM Agent usage limits", () => {
  it.effect("reads token and credit plans with independent session, weekly, and MCP quotas", () =>
    withServices(
      Effect.gen(function* () {
        for (const type of ["TOKENS_LIMIT", "CREDIT_LIMIT"]) {
          const limits = yield* readGlmUsageLimits({
            enabled,
            environment: { Z_AI_API_KEY: "test-key" },
          }).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              responseClient(
                quota([
                  { type, unit: 6, number: 1, percentage: 20, nextResetTime: 1789962786000 },
                  {
                    type: "TIME_LIMIT",
                    unit: 5,
                    number: 1,
                    percentage: 45,
                    currentValue: 450,
                    usage: 1000,
                    nextResetTime: 1790049186000,
                  },
                  { type, unit: 3, number: 5, percentage: 82, nextResetTime: 1789876386000 },
                ]),
              ),
            ),
          );
          expect(limits?.windows).toEqual([
            {
              id: "glm_session",
              kind: "session",
              label: "Session",
              windowDurationMins: 300,
              usedPercent: 82,
              resetsAt: "2026-09-20T03:53:06.000Z",
            },
            {
              id: "glm_weekly",
              kind: "weekly",
              label: "Weekly",
              windowDurationMins: 10080,
              usedPercent: 20,
              resetsAt: "2026-09-21T03:53:06.000Z",
            },
            {
              id: "glm_mcp_monthly",
              kind: "monthly",
              label: "MCP tools · Monthly",
              usedPercent: 45,
              resetsAt: "2026-09-22T03:53:06.000Z",
            },
          ]);
          expect(limits?.unavailable).toBeUndefined();
        }
      }),
    ),
  );

  it.effect("preserves zero usage without inventing a reset and clamps reported percentages", () =>
    withServices(
      Effect.gen(function* () {
        for (const [percentage, usedPercent] of [
          [0, 0],
          [-5, 0],
          [120, 100],
        ]) {
          const limits = yield* readGlmUsageLimits({
            enabled,
            environment: { Z_AI_API_KEY: "test-key" },
          }).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              responseClient(quota([{ ...session, percentage, nextResetTime: null }])),
            ),
          );
          expect(limits?.windows).toEqual([
            {
              id: "glm_session",
              kind: "session",
              label: "Session",
              windowDurationMins: 300,
              usedPercent,
            },
          ]);
        }
      }),
    ),
  );

  it.effect("ignores unrecognized quota kinds and periods without mislabeling them", () =>
    withServices(
      Effect.gen(function* () {
        const limits = yield* readGlmUsageLimits({
          enabled,
          environment: { Z_AI_API_KEY: "test-key" },
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            responseClient(
              quota([
                { type: "FUTURE_LIMIT", unit: 3, number: 5 },
                { ...session, unit: 6, number: 7 },
                { ...session, unit: 3, number: 24 },
                null,
                session,
              ]),
            ),
          ),
        );
        expect(limits?.windows).toHaveLength(1);
        expect(limits?.windows[0]?.usedPercent).toBe(42);
      }),
    ),
  );

  it.effect("reports missing or malformed quota values as failed probes", () =>
    withServices(
      Effect.gen(function* () {
        for (const invalid of [
          { type: "TOKENS_LIMIT", unit: 3, number: 5 },
          { ...session, percentage: "42" },
          { ...session, percentage: null },
          { ...session, nextResetTime: "1789876386000" },
        ]) {
          const limits = yield* readGlmUsageLimits({
            enabled,
            environment: { Z_AI_API_KEY: "test-key" },
          }).pipe(Effect.provideService(HttpClient.HttpClient, responseClient(quota([invalid]))));
          expect(limits?.windows).toEqual([]);
          expect(limits?.unavailable?.reason).toBe("probeFailed");
        }
      }),
    ),
  );

  it.effect("rejects HTTP and business errors without exposing private response content", () =>
    withServices(
      Effect.gen(function* () {
        for (const [status, body] of [
          [401, { error: "private response" }],
          [503, { error: "private response" }],
          [200, { ...quota([session]), success: false, msg: "private response" }],
          [200, { ...quota([session]), code: 401, msg: "private response" }],
          [200, { code: 200, success: true, data: {} }],
        ] as const) {
          const limits = yield* readGlmUsageLimits({
            enabled,
            environment: { Z_AI_API_KEY: "private-key" },
          }).pipe(Effect.provideService(HttpClient.HttpClient, responseClient(body, status)));
          expect(limits?.unavailable).toEqual({
            reason: "probeFailed",
            message: "GLM Agent could not read usage.",
          });
          expect(JSON.stringify(limits)).not.toContain("private");
        }
      }),
    ),
  );

  it.effect("accepts valid quota data when optional envelope flags are omitted", () =>
    withServices(
      Effect.gen(function* () {
        for (const body of [
          { data: { limits: [session] } },
          { code: 200, data: { limits: [session] } },
          { success: true, data: { limits: [session] } },
        ]) {
          const limits = yield* readGlmUsageLimits({
            enabled,
            environment: { Z_AI_API_KEY: "test-key" },
          }).pipe(Effect.provideService(HttpClient.HttpClient, responseClient(body)));
          expect(limits?.windows[0]?.usedPercent).toBe(42);
          expect(limits?.unavailable).toBeUndefined();
        }
      }),
    ),
  );

  it.effect("uses the environment key before saved credentials and sends the raw key", () =>
    withServices(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(path.join(directory, "glm-acp-agent"));
        yield* fs.writeFileString(
          path.join(directory, "glm-acp-agent", "credentials.json"),
          JSON.stringify({ z_ai_api_key: "saved-key" }),
        );
        for (const key of ["environment-key", "saved-key"]) {
          const limits = yield* readGlmUsageLimits({
            enabled,
            environment: {
              XDG_CONFIG_HOME: directory,
              ...(key === "environment-key" ? { Z_AI_API_KEY: key } : {}),
            },
          }).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make((request) => {
                expect(request.method).toBe("GET");
                expect(request.headers.authorization).toBe(key);
                return Effect.succeed(
                  HttpClientResponse.fromWeb(request, Response.json(quota([session]))),
                );
              }),
            ),
          );
          expect(limits?.windows[0]?.usedPercent).toBe(42);
        }
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("finds credentials in HOME and the host home when XDG config is unset", () =>
    withServices(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const config = path.join(directory, ".config", "glm-acp-agent");
        yield* fs.makeDirectory(config, { recursive: true });
        yield* fs.writeFileString(
          path.join(config, "credentials.json"),
          '{"z_ai_api_key":"home-key"}',
        );
        for (const environment of [{ HOME: directory }, {}]) {
          const limits = yield* readGlmUsageLimits({ enabled, environment }).pipe(
            Effect.provideService(HostProcess.HomeDirectory, directory),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make((request) => {
                expect(request.headers.authorization).toBe("home-key");
                return Effect.succeed(
                  HttpClientResponse.fromWeb(request, Response.json(quota([session]))),
                );
              }),
            ),
          );
          expect(limits?.windows[0]?.usedPercent).toBe(42);
        }
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("does not request limits without credentials or while disabled", () =>
    withServices(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        for (const current of [true, false]) {
          const limits = yield* readGlmUsageLimits({
            enabled: current,
            environment: {
              XDG_CONFIG_HOME: directory,
              ...(current ? {} : { Z_AI_API_KEY: "test-key" }),
            },
          }).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("must not request limits")),
            ),
          );
          if (current) expect(limits?.unavailable?.reason).toBe("unsupported");
          else expect(limits).toBeUndefined();
        }
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("keeps quota requests on the selected official coding origin", () =>
    withServices(
      Effect.gen(function* () {
        for (const origin of [
          "https://api.z.ai",
          "https://open.bigmodel.cn",
          "https://dev.bigmodel.cn",
        ]) {
          const limits = yield* readGlmUsageLimits({
            enabled,
            environment: {
              Z_AI_API_KEY: "test-key",
              ACP_GLM_BASE_URL: `${origin}/api/coding/paas/v4/`,
            },
          }).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make((request) => {
                expect(request.url).toBe(`${origin}/api/monitor/usage/quota/limit`);
                return Effect.succeed(
                  HttpClientResponse.fromWeb(request, Response.json(quota([session]))),
                );
              }),
            ),
          );
          expect(limits?.windows).toHaveLength(1);
        }
      }),
    ),
  );

  it.effect("skips custom, malformed, or non-coding endpoints", () =>
    withServices(
      Effect.gen(function* () {
        for (const ACP_GLM_BASE_URL of [
          "https://proxy.example/api/coding/paas/v4",
          "http://api.z.ai/api/coding/paas/v4",
          "https://api.z.ai/api/paas/v4",
          "https://api.z.ai/api/coding/paas/v4?account=other",
          "https://user:password@api.z.ai/api/coding/paas/v4",
          "not a URL",
          "",
        ]) {
          const limits = yield* readGlmUsageLimits({
            enabled,
            environment: { Z_AI_API_KEY: "test-key", ACP_GLM_BASE_URL },
          }).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("must not request a custom endpoint")),
            ),
          );
          expect(limits?.unavailable?.reason).toBe("unsupported");
        }
      }),
    ),
  );

  it.effect("identifies the same credential consistently and separates keys and regions", () =>
    withServices(
      Effect.gen(function* () {
        const fingerprints: Array<string | undefined> = [];
        for (const [key, origin] of [
          ["account-a", "https://api.z.ai"],
          ["account-a", "https://api.z.ai"],
          ["account-b", "https://api.z.ai"],
          ["account-a", "https://open.bigmodel.cn"],
        ] as const) {
          const limits = yield* readGlmUsageLimits({
            enabled,
            environment: { Z_AI_API_KEY: key, ACP_GLM_BASE_URL: `${origin}/api/coding/paas/v4` },
          }).pipe(Effect.provideService(HttpClient.HttpClient, responseClient(quota([session]))));
          fingerprints.push(limits?.credentialFingerprint);
          expect(JSON.stringify(limits)).not.toContain(key);
        }
        expect(fingerprints[0]).toMatch(/^[a-f0-9]{64}$/);
        expect(fingerprints[0]).toBe(fingerprints[1]);
        expect(new Set(fingerprints).size).toBe(3);
        const failed = yield* readGlmUsageLimits({
          enabled,
          environment: { Z_AI_API_KEY: "account-a" },
        }).pipe(Effect.provideService(HttpClient.HttpClient, responseClient({}, 503)));
        expect(failed?.credentialFingerprint).toBe(fingerprints[0]);
        expect(failed?.unavailable?.reason).toBe("probeFailed");
      }),
    ),
  );
});
