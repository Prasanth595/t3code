import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpServerResponse } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import { describe } from "vite-plus/test";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { FactoryLoop, type FactoryStatus } from "../index.ts";
import { route } from "./auth.ts";
import { FactoryRoutes, STATUS_PATH } from "./http.ts";

const TEST_ROUTE_PATH = "/api/factory/test/settings";

/** A route that needs a scope a standard client lacks, to prove the scope check. */
const testOnlyRoute = route(
  "GET",
  TEST_ROUTE_PATH,
  AuthSettingsWriteScope,
  Effect.succeed(HttpServerResponse.empty({ status: 204 })),
);

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-http-test-" })),
  Layer.provide(NodeServices.layer),
);

const layerRoutes = Layer.mergeAll(FactoryRoutes, testOnlyRoute).pipe(
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
);

const loopWith = (status: FactoryStatus) =>
  FactoryLoop.of({
    wake: Effect.void,
    awaitPass: Effect.never,
    passRunning: Effect.succeed(false),
    status,
  });

/** Runs `use` against the factory's routes behind T3's auth, with a loop reporting `status`. */
const serving = <A>(
  status: FactoryStatus,
  use: (
    get: (path: string, token?: string) => Promise<Response>,
    tokens: { readonly read: string; readonly settingsWrite: string },
  ) => Promise<A>,
) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const context = Context.make(EnvironmentAuth.EnvironmentAuth, auth).pipe(
      Context.add(FactoryLoop, loopWith(status)),
    );
    // Issued on the live clock: the handler checks expiry on it, not on the test clock.
    const issue = (scope: AuthEnvironmentScope) =>
      auth.issueSession({ scopes: [scope] }).pipe(
        TestClock.withLive,
        Effect.map((session) => session.token),
      );
    const tokens = {
      read: yield* issue(AuthOrchestrationReadScope),
      settingsWrite: yield* issue(AuthSettingsWriteScope),
    };
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      ({ handler }) =>
        Effect.tryPromise(() =>
          use(
            (path, token) =>
              handler(
                new Request(`http://127.0.0.1${path}`, {
                  headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
                }),
                context,
              ),
            tokens,
          ),
        ),
      ({ dispose }) => Effect.promise(dispose),
    );
  }).pipe(Effect.provide(layerEnvironmentAuth));

const idle: FactoryStatus = { state: "idle", reason: "no factory config" };
const running: FactoryStatus = {
  state: "running",
  settings: { pollSeconds: 60, maxConcurrentRuns: 2, repos: ["a/b"] },
};

describe("GET /api/factory/status", () => {
  it("is served at the path the Factory page calls", () => {
    assert.strictEqual(STATUS_PATH, "/api/factory/status");
  });

  it.effect("answers 401 without credentials", () =>
    serving(idle, async (get) => {
      const response = await get("/api/factory/status");
      assert.strictEqual(response.status, 401);
      assert.strictEqual(((await response.json()) as { code: string }).code, "auth_invalid");
    }),
  );

  it.effect("answers 401 for a token that is not a session", () =>
    serving(idle, async (get) => {
      const response = await get(STATUS_PATH, "not-a-session-token");
      assert.strictEqual(response.status, 401);
    }),
  );

  it.effect("needs orchestration:read, the scope every reading client holds", () =>
    serving(idle, async (get, tokens) => {
      const response = await get(STATUS_PATH, tokens.settingsWrite);
      assert.strictEqual(response.status, 403);
      assert.strictEqual(((await response.json()) as { code: string }).code, "insufficient_scope");
    }),
  );

  it.effect("reports an idle factory and why", () =>
    serving(idle, async (get, tokens) => {
      const response = await get("/api/factory/status", tokens.read);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(), idle);
    }),
  );

  it.effect("reports a running factory with no reason", () =>
    serving(running, async (get, tokens) => {
      const response = await get(STATUS_PATH, tokens.read);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(), running);
    }),
  );
});

describe("an auth failure inside T3", () => {
  it.effect("answers 500 internal_error, not 401, and never runs the handler", () => {
    let handled = false;
    const failingRoute = route(
      "GET",
      "/api/factory/test/internal",
      AuthOrchestrationReadScope,
      Effect.sync(() => {
        handled = true;
        return HttpServerResponse.empty({ status: 204 });
      }),
    );
    return Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const context = Context.make(EnvironmentAuth.EnvironmentAuth, {
        ...auth,
        authenticateHttpRequest: () =>
          Effect.fail(
            new EnvironmentAuth.ServerAuthSessionCredentialValidationError({
              cause: new Error("session store unreadable"),
            }),
          ),
      }).pipe(Context.add(FactoryLoop, loopWith(idle)));
      const layer = failingRoute.pipe(Layer.provideMerge(layerRoutes));
      const response = yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(layer, { disableLogger: true })),
        ({ handler }) =>
          Effect.promise(() =>
            handler(new Request("http://127.0.0.1/api/factory/test/internal"), context),
          ),
        ({ dispose }) => Effect.promise(dispose),
      );
      assert.strictEqual(response.status, 500);
      const body = (yield* Effect.promise(() => response.json())) as { code: string };
      assert.strictEqual(body.code, "internal_error");
      assert.isFalse(handled);
    }).pipe(Effect.provide(layerEnvironmentAuth));
  });
});

describe("the scope a route requires", () => {
  it.effect("answers 403 to a session without it", () =>
    serving(idle, async (get, tokens) => {
      const response = await get(TEST_ROUTE_PATH, tokens.read);
      assert.strictEqual(response.status, 403);
      assert.strictEqual(((await response.json()) as { code: string }).code, "insufficient_scope");
    }),
  );

  it.effect("lets a session with it through", () =>
    serving(idle, async (get, tokens) => {
      const response = await get(TEST_ROUTE_PATH, tokens.settingsWrite);
      assert.strictEqual(response.status, 204);
    }),
  );
});
