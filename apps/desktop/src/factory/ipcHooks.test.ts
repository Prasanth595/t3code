// Calls upstream's real IPC handlers so deleting a seam hook in window.ts fails a test.
// No backend pool or local auth is provided: without the hook the handlers need them and die.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  getLocalEnvironmentBearerToken,
  getLocalEnvironmentBootstraps,
} from "../ipc/methods/window.ts";
import { pairFactoryServer } from "./factoryServerIpc.ts";
import { layerDesktopEnvironment, layerSafeStorage } from "./testing.ts";

const layerHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() =>
      HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            access_token: "stored-bearer",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "environment:connect",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    ),
  ),
);

// The handlers' types still name the backend services the hooks bypass. Leaving them
// unprovided is the point: a deleted hook dies on the missing service.
const withoutBackend = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect as unknown as Effect.Effect<A, E, never>;

const packaged = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-factory-ipc-hooks-test-",
    });
    return yield* effect.pipe(
      Effect.provide(
        Layer.mergeAll(layerDesktopEnvironment(baseDir, true), layerSafeStorage, layerHttp),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("factory hooks in upstream IPC handlers", () => {
  it.effect("getLocalEnvironmentBootstraps returns the one primary entry at 3876", () =>
    packaged(
      Effect.gen(function* () {
        const bootstraps = (yield* withoutBackend(
          getLocalEnvironmentBootstraps.handler(),
        )) as ReadonlyArray<{ readonly httpBaseUrl: string }>;
        assert.equal(bootstraps.length, 1);
        assert.equal(bootstraps[0]?.httpBaseUrl, "http://127.0.0.1:3876/");
      }),
    ),
  );

  it.effect("getLocalEnvironmentBearerToken is empty before pairing, then the stored bearer", () =>
    packaged(
      Effect.gen(function* () {
        assert.equal(yield* withoutBackend(getLocalEnvironmentBearerToken.handler(undefined)), "");
        yield* pairFactoryServer.handler("abc123");
        assert.equal(
          yield* withoutBackend(getLocalEnvironmentBearerToken.handler(undefined)),
          "stored-bearer",
        );
      }),
    ),
  );
});
