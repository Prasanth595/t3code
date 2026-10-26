import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { AcpRequestError } from "effect-acp/errors";

import { readGlmPromptFailure } from "./promptFailure.ts";

const now = Date.parse("2026-10-26T12:00:00.000Z");
const sessionReset = "2026-10-27T03:41:01.000Z";
const weeklyReset = "2026-11-01T07:00:00.000Z";
const monthlyReset = "2026-11-26T12:00:00.000Z";
const session = { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 100 };
const weekly = { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 100 };
const monthly = { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 100 };
const message = (period = "5 hour") =>
  `429 Usage limit reached for ${period}. Your limit will reset at 2026-10-27 05:41:01`;
const sdkFailure = (details = message()) =>
  new AcpRequestError({ code: -32603, errorMessage: "Internal error", data: { details } });
const directFailure = (errorMessage = message()) =>
  new AcpRequestError({ code: 429, errorMessage });
const quota = (limits: ReadonlyArray<unknown>) => ({ code: 200, success: true, data: { limits } });
const responseClient = (limits: ReadonlyArray<unknown>) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(quota(limits)))),
  );
const noRequests = (requests: Array<string>) =>
  HttpClient.make((request) => {
    requests.push(request.url);
    return Effect.die("must not request usage limits");
  });
const withServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(HostProcess.HomeDirectory, "/unused-glm-test-home"),
  );

describe("GLM Agent prompt failure", () => {
  it.effect("uses the quota API reset for the SDK internal-error envelope", () =>
    withServices(
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const failure = yield* readGlmPromptFailure({
          cause: sdkFailure(),
          environment: { Z_AI_API_KEY: "test-key" },
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            responseClient([{ ...session, nextResetTime: Date.parse(sessionReset) }]),
          ),
        );
        expect(failure).toEqual({
          class: "usage_limit",
          code: "-32603",
          message: message(),
          retryable: true,
          resetAt: sessionReset,
        });
      }),
    ),
  );

  it.effect("resolves direct request errors and each known GLM quota period", () =>
    withServices(
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        for (const [period, window, resetAt] of [
          ["5 hour", session, sessionReset],
          ["7 day", weekly, weeklyReset],
          ["weekly", weekly, weeklyReset],
          ["monthly", monthly, monthlyReset],
          ["1 month", monthly, monthlyReset],
        ] as const) {
          const failure = yield* readGlmPromptFailure({
            cause: directFailure(message(period)),
            environment: { Z_AI_API_KEY: "test-key" },
          }).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              responseClient([{ ...window, nextResetTime: Date.parse(resetAt) }]),
            ),
          );
          expect(failure).toMatchObject({
            class: "usage_limit",
            code: "429",
            retryable: true,
            resetAt,
          });
        }
      }),
    ),
  );

  it.effect("waits for both exhausted chat windows and ignores the monthly tools quota", () =>
    withServices(
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        for (const period of ["5 hour", "7 day"]) {
          const failure = yield* readGlmPromptFailure({
            cause: sdkFailure(message(period)),
            environment: { Z_AI_API_KEY: "test-key" },
          }).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              responseClient([
                { ...session, nextResetTime: Date.parse(sessionReset) },
                { ...weekly, nextResetTime: Date.parse(weeklyReset) },
                { ...monthly, nextResetTime: Date.parse(monthlyReset) },
              ]),
            ),
          );
          expect(failure.resetAt).toBe(weeklyReset);
        }
      }),
    ),
  );

  it.effect("uses the reported window even when its quota snapshot is below 100 percent", () =>
    withServices(
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const failure = yield* readGlmPromptFailure({
          cause: sdkFailure(),
          environment: { Z_AI_API_KEY: "test-key" },
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            responseClient([
              { ...session, percentage: 99, nextResetTime: Date.parse(sessionReset) },
              { ...weekly, percentage: 50, nextResetTime: Date.parse(weeklyReset) },
              { ...monthly, nextResetTime: Date.parse(monthlyReset) },
            ]),
          ),
        );
        expect(failure.resetAt).toBe(sessionReset);
      }),
    ),
  );

  it.effect(
    "keeps manual resume when a required or exhausted chat window has no future reset",
    () =>
      withServices(
        Effect.gen(function* () {
          yield* TestClock.setTime(now);
          for (const windows of [
            [session],
            [{ ...session, nextResetTime: null }],
            [{ ...weekly, nextResetTime: Date.parse(weeklyReset) }],
            [{ ...session, nextResetTime: now }],
            [{ ...session, nextResetTime: now - 1 }],
            [{ ...session, nextResetTime: Date.parse(sessionReset) }, weekly],
          ]) {
            const failure = yield* readGlmPromptFailure({
              cause: sdkFailure(),
              environment: { Z_AI_API_KEY: "test-key" },
            }).pipe(Effect.provideService(HttpClient.HttpClient, responseClient(windows)));
            expect(failure.class).toBe("usage_limit");
            expect(failure.resetAt).toBeUndefined();
          }
        }),
      ),
  );

  it.effect("keeps a recognized usage failure when the quota API is unavailable", () =>
    withServices(
      Effect.gen(function* () {
        for (const client of [
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ error: "private" }, { status: 503 }),
              ),
            ),
          ),
          HttpClient.make(() => Effect.die(new Error("private service failure"))),
        ]) {
          const failure = yield* readGlmPromptFailure({
            cause: sdkFailure(),
            environment: { Z_AI_API_KEY: "test-key" },
          }).pipe(Effect.provideService(HttpClient.HttpClient, client));
          expect(failure).toEqual({
            class: "usage_limit",
            code: "-32603",
            message: message(),
            retryable: true,
          });
        }
      }),
    ),
  );

  it.effect("keeps manual resume without credentials or with a custom origin", () =>
    withServices(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const requests: Array<string> = [];
        for (const environment of [
          { XDG_CONFIG_HOME: directory },
          {
            Z_AI_API_KEY: "test-key",
            ACP_GLM_BASE_URL: "https://proxy.example/api/coding/paas/v4",
          },
        ]) {
          const failure = yield* readGlmPromptFailure({ cause: sdkFailure(), environment }).pipe(
            Effect.provideService(HttpClient.HttpClient, noRequests(requests)),
          );
          expect(failure.class).toBe("usage_limit");
          expect(failure.resetAt).toBeUndefined();
        }
        expect(requests).toEqual([]);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("probes the official origin and credentials from the provider environment", () =>
    withServices(
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const failure = yield* readGlmPromptFailure({
          cause: sdkFailure(),
          environment: {
            Z_AI_API_KEY: "provider-key",
            ACP_GLM_BASE_URL: "https://open.bigmodel.cn/api/coding/paas/v4",
          },
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              expect(request.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
              expect(request.headers.authorization).toBe("provider-key");
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json(quota([{ ...session, nextResetTime: Date.parse(sessionReset) }])),
                ),
              );
            }),
          ),
        );
        expect(failure.resetAt).toBe(sessionReset);
      }),
    ),
  );

  it.effect("does not probe unrelated failures or an unknown usage window", () =>
    withServices(
      Effect.gen(function* () {
        const requests: Array<string> = [];
        for (const cause of [
          new Error(message()),
          sdkFailure("429 Too many requests"),
          directFailure(message("1 year")),
          new AcpRequestError({ code: -32602, errorMessage: message() }),
        ]) {
          const failure = yield* readGlmPromptFailure({
            cause,
            environment: { Z_AI_API_KEY: "test-key" },
          }).pipe(Effect.provideService(HttpClient.HttpClient, noRequests(requests)));
          expect(failure.resetAt).toBeUndefined();
        }
        expect(requests).toEqual([]);
      }),
    ),
  );
});
