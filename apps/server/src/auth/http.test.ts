import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  AuthTokenExchangeGrantType,
  AuthEnvironmentBootstrapTokenType,
  AuthAccessTokenType,
  EnvironmentAuthenticatedAuth,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { RelayClientTracer } from "@t3tools/shared/relayTracing";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerConfig),
);
const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(AuthHttp.layer),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provideMerge(layerEnvironmentAuth),
  Layer.provide(layerConfig),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.tryPromise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const retiredScopeResponse = await environmentA.handler(
            new Request("http://127.0.0.1/oauth/token", {
              method: "POST",
              body: new URLSearchParams({
                grant_type: AuthTokenExchangeGrantType,
                subject_token: DEV_TOKEN,
                subject_token_type: AuthEnvironmentBootstrapTokenType,
                requested_token_type: AuthAccessTokenType,
                scope: "review:write",
              }),
            }),
            requestContext,
          );
          expect(retiredScopeResponse.status).toBe(400);
          expect(await retiredScopeResponse.json()).toMatchObject({ reason: "invalid_scope" });

          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("exports only verified T3 Connect requests", () =>
  Effect.gen(function* () {
    const productSpans: Array<string> = [];
    const localSpans: Array<string> = [];
    const collect = (into: Array<string>) =>
      Tracer.make({
        span: (options) => {
          into.push(options.name);
          return new Tracer.NativeSpan(options);
        },
      });
    // "DPoP connect" is a T3 Connect session; any other DPoP token is rejected.
    const environmentAuth = {
      authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) =>
        (request.headers.authorization === "DPoP forged"
          ? Effect.fail(
              new EnvironmentAuth.ServerAuthInvalidCredentialError({ diagnostic: "forged" }),
            )
          : Effect.succeed({
              sessionId: AuthSessionId.make("session-1"),
              subject:
                request.headers.authorization === "DPoP connect"
                  ? "cloud-connect"
                  : "cli-issued-session",
              method: "bearer-access-token" as const,
              scopes: ["orchestration:read" as const],
            })
        ).pipe(Effect.withSpan("EnvironmentAuth.authenticateHttpRequest")),
    } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
    const middleware = yield* Layer.build(AuthHttp.layerAuthenticatedAuth).pipe(
      Effect.provideService(EnvironmentAuth.EnvironmentAuth, environmentAuth),
      Effect.map(Context.get(EnvironmentAuthenticatedAuth)),
    );
    const handle = (authorization: string) =>
      (
        middleware as unknown as (
          effect: Effect.Effect<void>,
        ) => Effect.Effect<void, Error, HttpServerRequest.HttpServerRequest>
      )(Effect.void.pipe(Effect.withSpan("environment.handler"))).pipe(
        Effect.ignore,
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("https://environment.example.test/api/orchestration/shell", {
              headers: {
                authorization,
                traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
              },
            }),
          ),
        ),
        Effect.provideService(RelayClientTracer, Option.some(collect(productSpans))),
        Effect.withTracer(collect(localSpans)),
      );

    yield* handle("DPoP connect");
    expect(productSpans).toEqual([
      "environment.relay.request",
      "EnvironmentAuth.authenticateHttpRequest",
      "environment.handler",
    ]);
    expect(localSpans).toEqual(["EnvironmentAuth.authenticateHttpRequest"]);

    productSpans.length = 0;
    localSpans.length = 0;
    yield* handle("DPoP forged");
    expect(productSpans).toEqual([]);
    expect(localSpans).toEqual(["EnvironmentAuth.authenticateHttpRequest"]);

    localSpans.length = 0;
    yield* handle("Bearer access-token");
    expect(productSpans).toEqual([]);
    expect(localSpans).toEqual(["EnvironmentAuth.authenticateHttpRequest", "environment.handler"]);
  }).pipe(Effect.scoped),
);

it.effect("retains safe request attribution after request spans are discarded", () =>
  Effect.gen(function* () {
    const messages: Array<unknown> = [];
    const spans: Array<Tracer.NativeSpan> = [];
    const expected: Array<{ traceId: string; spanId: string }> = [];
    const parent = Tracer.externalSpan({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
    });
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const secret = "fixture-secret-never-in-diagnostics";
    const request = HttpServerRequest.fromWeb(
      new Request(`https://example.invalid/api/threads/${secret}?token=${secret}`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
        body: secret,
      }),
    );
    const route = HttpRouter.route("POST", "/api/threads/:threadId", HttpServerResponse.empty());
    for (const interrupted of [false, true]) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const span = yield* Effect.currentParentSpan;
          expected.push({ traceId: span.traceId, spanId: span.spanId });
          yield* AuthHttp.annotateEnvironmentRequest("HttpApiEndpoint");
          expect(span.traceId).toBe(parent.traceId);
          expect(span.spanId).not.toBe(parent.spanId);
          const attributes = Object.fromEntries(
            spans.find((item) => item.spanId === span.spanId)!.attributes,
          );
          expect(attributes["http.route"]).toBe("/api/threads/:threadId");
          expect(attributes).not.toHaveProperty("url.path");
          expect(JSON.stringify(attributes)).not.toContain(secret);
          // The final record must stand alone after the trace sink evicts spans.
          spans.length = 0;
          return yield* interrupted
            ? Effect.interrupt
            : Effect.fail({ _tag: "SyntheticFailure", message: secret, body: secret });
        }),
      ).pipe(
        Effect.withSpan("request"),
        Effect.withParentSpan(parent),
        Effect.exit,
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(HttpRouter.RouteContext, { route, params: { threadId: secret } }),
        Effect.withTracer(tracer),
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      );
    }
    expect(spans).toHaveLength(0);
    expect(messages).toHaveLength(2);
    for (let i = 0; i < messages.length; i++) {
      expect(messages[i]).toEqual([
        "environment api request failed",
        expect.objectContaining({
          endpoint: "HttpApiEndpoint",
          method: "POST",
          route: "/api/threads/:threadId",
          ...expected[i],
          errorTag: i === 0 ? "SyntheticFailure" : "Interrupt",
        }),
      ]);
    }
    expect(JSON.stringify(messages)).not.toContain(secret);
    expect(JSON.stringify(messages)).not.toContain("example.invalid");
  }),
);

it.effect("uses a fixed unmatched route when route context is unavailable", () =>
  Effect.gen(function* () {
    const messages: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    yield* Effect.scoped(
      AuthHttp.annotateEnvironmentRequest("HttpApiEndpoint").pipe(
        Effect.andThen(Effect.fail({ _tag: "SyntheticFailure" })),
      ),
    ).pipe(
      Effect.exit,
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request("https://example.invalid/private-secret?token=secret"),
        ),
      ),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
    expect(messages).toEqual([
      [
        "environment api request failed",
        expect.objectContaining({
          method: "GET",
          route: "unmatched",
        }),
      ],
    ]);
    expect(JSON.stringify(messages)).not.toContain("secret");
  }),
);

it.effect("does not emit request failure records for successful requests", () =>
  Effect.gen(function* () {
    const messages: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    yield* Effect.scoped(AuthHttp.annotateEnvironmentRequest("HttpApiEndpoint")).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request("https://example.invalid/")),
      ),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
    expect(messages).toEqual([]);
  }),
);
