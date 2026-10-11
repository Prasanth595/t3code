import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const ACCESS_TEAM = "team.cloudflareaccess.com";
const CERTS_URL = `https://${ACCESS_TEAM}/cdn-cgi/access/certs`;
const accessKeys = await generateKeyPair("RS256");
const accessJwk = { ...(await exportJWK(accessKeys.publicKey)), kid: "key-1", alg: "RS256" };
const signAccessJwt = (email: string) =>
  new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "key-1" })
    .setIssuer(`https://${ACCESS_TEAM}`)
    .setAudience("aud-tag")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(accessKeys.privateKey);

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      cloudflareAccess: { teamDomain: ACCESS_TEAM, aud: "aud-tag", subjects: ["dev@example.com"] },
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-access-test-" })));

const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(AuthHttp.layer),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provideMerge(
    EnvironmentAuth.layer.pipe(
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ServerEnvironment.layerIdentity),
      Layer.provide(layerConfig),
    ),
  ),
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
const request = (path: string, init?: { method?: string; headers?: Record<string, string> }) =>
  new Request(`http://127.0.0.1${path}`, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json", ...init?.headers },
    ...(init?.method === "POST" ? { body: encodeJson({}) } : {}),
  });

// The Access keys come from the team certs URL, so the test serves them from a fetch stub.
const withCertsFetch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
        (input instanceof Request ? input.url : String(input)) === CERTS_URL
          ? Response.json({ keys: [accessJwk] })
          : realFetch(input, init)) as typeof fetch;
      return realFetch;
    }),
    () => effect,
    (realFetch) => Effect.sync(() => (globalThis.fetch = realFetch)),
  );

it.effect("logs a Cloudflare Access caller in without a pairing link", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const requestContext = Context.make(Crypto.Crypto, crypto);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.tryPromise(async () => {
          const allowed = await signAccessJwt("dev@example.com");
          const unlisted = await signAccessJwt("someone@example.com");

          const anonymous = await environment.handler(
            request("/api/auth/session", { headers: { "cf-access-jwt-assertion": unlisted } }),
            requestContext,
          );
          expect(await anonymous.json()).toMatchObject({ authenticated: false });
          expect(anonymous.headers.getSetCookie()).toHaveLength(0);

          const session = await environment.handler(
            request("/api/auth/session", { headers: { "cf-access-jwt-assertion": allowed } }),
            requestContext,
          );
          expect(await session.json()).toMatchObject({ authenticated: true });
          const cookie = session.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
          expect(cookie).toMatch(/^t3_session_/);
          const withCookie = await environment.handler(
            request("/api/auth/session", { headers: { cookie } }),
            requestContext,
          );
          expect(await withCookie.json()).toMatchObject({ authenticated: true });
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(withCertsFetch, Effect.provide(NodeServices.layer)),
);

it.effect("gives a pairing credential only to a Cloudflare Access caller", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const requestContext = Context.make(Crypto.Crypto, crypto);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.tryPromise(async () => {
          const path = "/api/auth/cloudflare-access/pairing-credential";
          const rejected = await environment.handler(
            request(path, { method: "POST" }),
            requestContext,
          );
          expect(rejected.status).toBe(401);

          const allowed = await signAccessJwt("dev@example.com");
          const pairing = await environment.handler(
            request(path, { method: "POST", headers: { "cf-access-jwt-assertion": allowed } }),
            requestContext,
          );
          expect(pairing.status).toBe(200);
          const { credential } = (await pairing.json()) as { credential: string };
          const exchange = () =>
            environment.handler(
              new Request("http://127.0.0.1/api/auth/browser-session", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: encodeJson({ credential }),
              }),
              requestContext,
            );
          expect((await exchange()).status).toBe(200);
          expect((await exchange()).status).toBe(401);
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(withCertsFetch, Effect.provide(NodeServices.layer)),
);
