import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as TestClock from "effect/testing/TestClock";
import * as Crypto from "effect/Crypto";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import type { CursorCredentialState } from "./auth.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as CursorKeychain from "./CursorKeychain.ts";
import { cursorUsageResponseToLimits, readCursorUsageLimits } from "./usageLimits.ts";

const withNodeServices = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto | CursorKeychain.CursorKeychain
  >,
  accessToken: CursorKeychain.CursorKeychain["Service"]["accessToken"] = Effect.die(
    "must not read Keychain",
  ),
) =>
  effect.pipe(
    Effect.provideService(CursorKeychain.CursorKeychain, { accessToken }),
    Effect.provide(NodeServices.layer),
  );

describe("Cursor usage limits", () => {
  const checkedAt = "2026-09-16T00:00:00.000Z";

  it("uses the advertised percentages and billing-cycle reset", () => {
    const limits = cursorUsageResponseToLimits(
      {
        billingCycleEnd: "1789876386000",
        planUsage: { totalPercentUsed: 72.4, autoPercentUsed: 69.5, apiPercentUsed: 100 },
      },
      checkedAt,
    );
    expect(limits.windows).toEqual(
      expect.arrayContaining([
        {
          id: "totalPercentUsed",
          kind: "monthly",
          label: "Overall",
          usedPercent: 72.4,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "autoPercentUsed",
          kind: "monthly",
          label: "Cursor Models",
          usedPercent: 69.5,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "apiPercentUsed",
          kind: "monthly",
          label: "Other Models",
          usedPercent: 100,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
      ]),
    );
  });

  it("does not invent unused allowance for absent buckets", () => {
    expect(cursorUsageResponseToLimits({ planUsage: {} }, checkedAt).unavailable?.reason).toBe(
      "unsupported",
    );
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 0 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 0 }]);
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 150 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 100 }]);
  });

  it.effect("reads the instance's credentials and endpoint even when usage enabled is false", () =>
    Effect.gen(function* () {
      yield* withNodeServices(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped();
          yield* fs.makeDirectory(path.join(directory, "cursor"));
          yield* fs.writeFileString(
            path.join(directory, "cursor", "auth.json"),
            '{"accessToken":"instance-token"}',
          );
          const client = HttpClient.make((request) => {
            expect(request.url).toBe(
              "https://cursor.example/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
            );
            expect(request.method).toBe("POST");
            expect(request.headers.authorization).toBe("Bearer instance-token");
            expect(request.headers["connect-protocol-version"]).toBe("1");
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ enabled: false, planUsage: { totalPercentUsed: 42 } }),
              ),
            );
          });
          yield* fs.makeDirectory(path.join(directory, ".cursor"));
          yield* fs.writeFileString(
            path.join(directory, ".cursor", "auth.json"),
            '{"accessToken":"instance-token"}',
          );
          for (const platform of ["linux", "darwin"] as const) {
            const limits = yield* readCursorUsageLimits(
              { apiEndpoint: "https://cursor.example/" },
              { XDG_CONFIG_HOME: directory, HOME: directory, AGENT_CLI_CREDENTIAL_STORE: "file" },
            ).pipe(
              Effect.provideService(HostProcess.Platform, platform),
              Effect.provideService(HttpClient.HttpClient, client),
            );
            expect(limits.windows[0]?.usedPercent).toBe(42);
          }
        }).pipe(Effect.scoped),
      );
    }),
  );

  it.effect(
    "never reads stale files for keychain or memory logins, but accepts an explicit auth token",
    () =>
      Effect.gen(function* () {
        for (const platform of ["linux", "darwin"] as const) {
          for (const token of [undefined, "explicit-token"]) {
            const limits = yield* withNodeServices(
              readCursorUsageLimits(
                { apiEndpoint: "" },
                {
                  AGENT_CLI_CREDENTIAL_STORE: platform === "linux" ? "memory" : "default",
                  ...(token ? { CURSOR_AUTH_TOKEN: token } : {}),
                },
                false,
              ).pipe(
                Effect.provideService(HostProcess.Platform, platform),
                Effect.provideService(
                  FileSystem.FileSystem,
                  FileSystem.makeNoop({
                    readFileString: () => Effect.die("must not read an unrelated credential file"),
                  }),
                ),
                Effect.provideService(
                  HttpClient.HttpClient,
                  HttpClient.make((request) => {
                    expect(token).toBe("explicit-token");
                    expect(request.headers.authorization).toBe("Bearer explicit-token");
                    return Effect.succeed(
                      HttpClientResponse.fromWeb(
                        request,
                        Response.json({ planUsage: { totalPercentUsed: 10 } }),
                      ),
                    );
                  }),
                ),
              ),
            );
            if (token) expect(limits.windows[0]?.usedPercent).toBe(10);
            else expect(limits.unavailable?.reason).toBe("unsupported");
          }
        }
      }),
  );

  it.effect("reports failed requests without exposing credentials or response bodies", () =>
    Effect.gen(function* () {
      const limits = yield* withNodeServices(
        readCursorUsageLimits({ apiEndpoint: "" }, { CURSOR_AUTH_TOKEN: "private-token" }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response("private response", { status: 401 }),
                ),
              ),
            ),
          ),
        ),
      );
      expect(limits.unavailable).toEqual({
        reason: "probeFailed",
        message: "Cursor could not read usage limits.",
      });
    }),
  );

  it.effect("does not use a stored login for an explicit API key", () =>
    Effect.gen(function* () {
      const limits = yield* withNodeServices(
        readCursorUsageLimits({ apiEndpoint: "" }, { CURSOR_API_KEY: "different-account" }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not request usage")),
          ),
        ),
      );
      expect(limits.unavailable?.reason).toBe("unsupported");
    }),
  );

  it.effect("reads the default macOS Cursor login from Keychain for limits", () =>
    Effect.gen(function* () {
      const limits = yield* withNodeServices(
        readCursorUsageLimits({ apiEndpoint: "" }, {}, true).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              readFileString: () => Effect.die("must not read a stale credential file"),
            }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              expect(request.headers.authorization).toBe("Bearer keychain-token");
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ planUsage: { totalPercentUsed: 42 } }),
                ),
              );
            }),
          ),
        ),
        Effect.succeed("keychain-token"),
      );
      expect(limits.windows[0]?.usedPercent).toBe(42);
    }),
  );

  it.effect("reports a Keychain initialization failure without failing the provider refresh", () =>
    Effect.gen(function* () {
      const limits = yield* withNodeServices(
        readCursorUsageLimits({ apiEndpoint: "" }, {}, true).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not request limits without a login")),
          ),
        ),
        Effect.fail(
          new CursorKeychain.CursorKeychainReadError({
            cause: new Error("Keychain initialization failed"),
          }),
        ),
      );
      expect(limits.unavailable?.reason).toBe("probeFailed");
    }),
  );

  it.effect("does not read Keychain or send its token to a custom endpoint", () =>
    Effect.gen(function* () {
      for (const [apiEndpoint, environment] of [
        ["http://localhost:3000", {}],
        ["", { CURSOR_API_ENDPOINT: "http://localhost:3000" }],
        ["https://cursor-proxy.example", {}],
        ["", { CURSOR_API_ENDPOINT: "https://cursor-proxy.example" }],
      ] as const) {
        const limits = yield* withNodeServices(
          readCursorUsageLimits({ apiEndpoint }, environment, true).pipe(
            Effect.provideService(HostProcess.Platform, "darwin"),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("must not send a Keychain credential to a proxy")),
            ),
          ),
        );
        expect(limits.unavailable?.reason).toBe("unsupported");
        expect(limits.unavailable?.message).toContain("default Cursor endpoint");
      }
    }),
  );
});

const exchangePath = "/auth/exchange_user_api_key";
const usagePath = "/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const storedCredential = {
  status: "valid",
  apiKey: "private-instance-key",
  backendUrl: "https://instance.example/path",
} as const;
const usage = () => Response.json({ planUsage: { totalPercentUsed: 37 } });
const makeProbe = (
  instanceId: string,
  answer: (request: HttpClientRequest.HttpClientRequest, index: number) => Response = (request) =>
    request.url.endsWith(exchangePath)
      ? Response.json({ accessToken: "private-access-token" })
      : usage(),
) => {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const client = HttpClient.make((request, _url, _signal, fiber) => {
    expect(Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect).toBe(
      "error",
    );
    expect(request.method).toBe("POST");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(
      request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : null,
    ).toBe("{}");
    requests.push(request);
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, answer(request, requests.length - 1)),
    );
  });
  const probe = (
    credential: CursorCredentialState = storedCredential,
    environment: NodeJS.ProcessEnv = {},
  ) =>
    withNodeServices(
      readCursorUsageLimits({ apiEndpoint: "https://unrelated.example" }, environment, true, {
        instanceId,
        credential,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: () => Effect.die("must not read host auth"),
          }),
        ),
      ),
    );
  return { probe, requests };
};

it.effect(
  "publishes stored-login limits at its backend origin without reading host credentials",
  () =>
    Effect.gen(function* () {
      for (const [index, environment] of [
        {},
        { CURSOR_AUTH_TOKEN: "other-host-account" },
        { AGENT_CLI_CREDENTIAL_STORE: "file" },
        { AGENT_CLI_CREDENTIAL_STORE: "default" },
      ].entries()) {
        const harness = makeProbe(`own-login-${index}`);
        expect((yield* harness.probe(storedCredential, environment)).windows[0]?.usedPercent).toBe(
          37,
        );
        expect(
          harness.requests.map((request) => [request.url, request.headers.authorization]),
        ).toEqual([
          [`https://instance.example${exchangePath}`, "Bearer private-instance-key"],
          [`https://instance.example${usagePath}`, "Bearer private-access-token"],
        ]);
        expect(harness.requests[1]?.headers["x-cursor-client-type"]).toBe("sdk");
        expect(harness.requests[1]?.headers["connect-protocol-version"]).toBe("1");
      }
    }),
);

it.effect("reports expired credentials as requiring re-login without requests", () =>
  Effect.gen(function* () {
    const harness = makeProbe("expired");
    expect((yield* harness.probe({ status: "expired" })).unavailable).toMatchObject({
      reason: "unsupported",
      message: expect.stringContaining("Sign in again"),
    });
    expect(harness.requests).toHaveLength(0);
  }),
);

it.effect("reuses a cached token on the next probe", () =>
  Effect.gen(function* () {
    const harness = makeProbe("cache-reuse");
    yield* harness.probe();
    expect((yield* harness.probe()).windows[0]?.usedPercent).toBe(37);
    expect(harness.requests.map((request) => request.url)).toEqual([
      `https://instance.example${exchangePath}`,
      `https://instance.example${usagePath}`,
      `https://instance.example${usagePath}`,
    ]);
  }),
);

it.effect("exchanges a new token when the same instance and key change backend origin", () =>
  Effect.gen(function* () {
    const harness = makeProbe("cache-origin-change", (request) =>
      request.url.endsWith(exchangePath)
        ? Response.json({
            accessToken: request.url.startsWith("https://instance.example/")
              ? "old-origin-token"
              : "new-origin-token",
          })
        : usage(),
    );
    yield* harness.probe();
    expect(
      (yield* harness.probe({ ...storedCredential, backendUrl: "https://new.example/path" }))
        .windows[0]?.usedPercent,
    ).toBe(37);
    expect(harness.requests.map((request) => [request.url, request.headers.authorization])).toEqual(
      [
        [`https://instance.example${exchangePath}`, "Bearer private-instance-key"],
        [`https://instance.example${usagePath}`, "Bearer old-origin-token"],
        [`https://new.example${exchangePath}`, "Bearer private-instance-key"],
        [`https://new.example${usagePath}`, "Bearer new-origin-token"],
      ],
    );
    yield* harness.probe();
    expect(harness.requests.slice(4).map((request) => request.url)).toEqual([
      `https://instance.example${exchangePath}`,
      `https://instance.example${usagePath}`,
    ]);
  }),
);

it.effect("refreshes a JWT at its seconds-based expiry minus the 60-second margin", () =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const exp = Math.floor(now / 1000) + 600;
    const jwt = [
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ exp })).toString("base64url"),
      Buffer.from("test-signature").toString("base64url"),
    ].join(".");
    const harness = makeProbe("jwt-expiry", (request, index) =>
      request.url.endsWith(exchangePath)
        ? Response.json({ accessToken: index === 0 ? jwt : "refreshed-token" })
        : usage(),
    );
    yield* harness.probe();
    yield* TestClock.adjust(exp * 1000 - 60_000 - now - 1);
    expect((yield* harness.probe()).windows[0]?.usedPercent).toBe(37);
    expect(harness.requests.map((request) => request.headers.authorization)).toEqual([
      "Bearer private-instance-key",
      `Bearer ${jwt}`,
      `Bearer ${jwt}`,
    ]);
    yield* TestClock.adjust(2);
    expect((yield* harness.probe()).windows[0]?.usedPercent).toBe(37);
    expect(
      harness.requests.slice(3).map((request) => [request.url, request.headers.authorization]),
    ).toEqual([
      [`https://instance.example${exchangePath}`, "Bearer private-instance-key"],
      [`https://instance.example${usagePath}`, "Bearer refreshed-token"],
    ]);
  }),
);

it.effect("re-exchanges a cached-token 401 once and reports a second 401 as probeFailed", () =>
  Effect.gen(function* () {
    for (const retryStatus of [200, 401]) {
      const harness = makeProbe(`cached-401-${retryStatus}`, (request, index) =>
        request.url.endsWith(exchangePath)
          ? Response.json({ accessToken: `access-${index}` })
          : index === 2 || (index === 4 && retryStatus === 401)
            ? new Response("private-response", { status: 401 })
            : usage(),
      );
      yield* harness.probe();
      const result = yield* harness.probe();
      expect(harness.requests.map((request) => request.url.split("/").at(-1))).toEqual([
        "exchange_user_api_key",
        "GetCurrentPeriodUsage",
        "GetCurrentPeriodUsage",
        "exchange_user_api_key",
        "GetCurrentPeriodUsage",
      ]);
      expect(harness.requests[4]?.headers.authorization).toBe("Bearer access-3");
      if (retryStatus === 200) expect(result.windows[0]?.usedPercent).toBe(37);
      else expect(result.unavailable?.reason).toBe("probeFailed");
    }
  }),
);

it.effect("handles exchange rejection, rate limits and redirects without retries", () =>
  Effect.gen(function* () {
    for (const [status, reason] of [
      [401, "unsupported"],
      [429, "probeFailed"],
      [302, "probeFailed"],
    ] as const) {
      const harness = makeProbe(
        `exchange-${status}`,
        () =>
          new Response("private-response", {
            status,
            headers: { location: "https://redirect.example" },
          }),
      );
      const result = yield* harness.probe();
      expect(result.unavailable?.reason).toBe(reason);
      expect(harness.requests).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("private-response");
    }
  }),
);

it.effect("refuses insecure and userinfo backends with zero requests", () =>
  Effect.gen(function* () {
    const harness = makeProbe("invalid-backends");
    for (const backendUrl of [
      "http://instance.example",
      "https://user@instance.example",
      "https://user:password@instance.example",
    ]) {
      expect((yield* harness.probe({ ...storedCredential, backendUrl })).unavailable?.reason).toBe(
        "probeFailed",
      );
    }
    expect(harness.requests).toHaveLength(0);
  }),
);

it.effect("isolates instance caches and prunes the old key on rotation", () =>
  Effect.gen(function* () {
    const first = makeProbe("cache-first");
    const second = makeProbe("cache-second");
    yield* first.probe();
    yield* second.probe();
    yield* first.probe();
    yield* second.probe();
    expect(first.requests).toHaveLength(3);
    expect(second.requests).toHaveLength(3);
    yield* first.probe({ ...storedCredential, apiKey: "rotated-key" });
    yield* first.probe();
    expect(first.requests.slice(3).map((request) => request.url)).toEqual([
      `https://instance.example${exchangePath}`,
      `https://instance.example${usagePath}`,
      `https://instance.example${exchangePath}`,
      `https://instance.example${usagePath}`,
    ]);
    yield* second.probe();
    expect(second.requests).toHaveLength(4);
  }),
);

it.effect("keeps secrets out of usage failure strings", () =>
  Effect.gen(function* () {
    const harness = makeProbe("secret-output", (request) =>
      request.url.endsWith(exchangePath)
        ? Response.json({
            accessToken: "private-access-token",
            refreshToken: "private-refresh-token",
          })
        : new Response("private-response-body", { status: 500 }),
    );
    const result = yield* harness.probe();
    expect(harness.requests.map((request) => [request.url, request.headers.authorization])).toEqual(
      [
        [`https://instance.example${exchangePath}`, "Bearer private-instance-key"],
        [`https://instance.example${usagePath}`, "Bearer private-access-token"],
      ],
    );
    expect(result.unavailable).toEqual({
      reason: "probeFailed",
      message: "Cursor could not read usage limits.",
    });
    const output = JSON.stringify(result);
    for (const secret of [
      "private-instance-key",
      "private-access-token",
      "private-refresh-token",
      "private-response-body",
    ])
      expect(output).not.toContain(secret);
  }),
);
