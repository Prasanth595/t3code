import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";

import { EnvironmentId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";

import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import type {
  DesktopBackendSnapshot,
  DesktopBackendStartConfig,
} from "../backend/DesktopBackendManager.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "./DesktopWslEnvironment.ts";
import * as DesktopWslBackend from "./DesktopWslBackend.ts";

function makeStubInstance(input: {
  readonly id: DesktopBackendPool.BackendInstanceId;
  readonly label: string;
  readonly snapshot: DesktopBackendSnapshot;
  readonly start?: Effect.Effect<void>;
  readonly ready?: boolean;
}): DesktopBackendPool.DesktopBackendInstance {
  return {
    id: input.id,
    label: Effect.succeed(input.label),
    start: input.start ?? Effect.void,
    stop: () => Effect.void,
    currentConfig: Effect.succeed(Option.none<DesktopBackendStartConfig>()),
    snapshot: Effect.succeed(input.snapshot),
    waitForReady: (_timeout: Duration.Duration) => Effect.succeed(input.ready ?? false),
  };
}

const idleSnapshot: DesktopBackendSnapshot = {
  desiredRunning: false,
  ready: false,
  activePid: Option.none(),
  restartAttempt: 5,
  restartScheduled: false,
};

const primarySnapshot: DesktopBackendSnapshot = {
  desiredRunning: true,
  ready: true,
  activePid: Option.some(123),
  restartAttempt: 0,
  restartScheduled: false,
};

const layerServerExposure = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 3773,
    bindHost: "127.0.0.1",
    httpBaseUrl: new URL("http://127.0.0.1:3773"),
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.succeed([]),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);

const layerBackendConfiguration = Layer.succeed(
  DesktopBackendConfiguration.DesktopBackendConfiguration,
  {
    resolvePrimary: Effect.die("unexpected resolvePrimary"),
    resolvePrimaryLabel: Effect.succeed("Windows"),
    resolveWsl: () => Effect.die("unexpected resolveWsl"),
    currentBootstrapToken: Effect.die("unexpected currentBootstrapToken"),
  } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"],
);

const layerNet = Layer.succeed(NetService.NetService, {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
} satisfies NetService.NetService["Service"]);

const layerHttpClient = (respond: (url: string) => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, respond(request.url))),
    ),
  );

const primaryDescriptor = {
  environmentId: "primary-env",
  label: "Windows",
  platform: { os: "windows", arch: "x64" },
  serverVersion: "0.0.50",
  capabilities: { repositoryIdentity: true },
};

describe("DesktopWslBackend", () => {
  it.effect("clears the stored preflight error when a registered WSL backend becomes ready", () => {
    let registeredSpec: DesktopBackendPool.BackendInstanceSpec | undefined;
    let registeredWsl: DesktopBackendPool.DesktopBackendInstance | undefined;
    let startCount = 0;
    const primary = makeStubInstance({
      id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
      label: "Windows",
      snapshot: primarySnapshot,
    });
    const layerPool = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
      get: (id) =>
        Effect.succeed(
          id === DesktopBackendPool.PRIMARY_INSTANCE_ID
            ? Option.some(primary)
            : Option.none<DesktopBackendPool.DesktopBackendInstance>(),
        ),
      list: Effect.sync(() => (registeredWsl === undefined ? [primary] : [primary, registeredWsl])),
      primary: Effect.succeed(primary),
      register: (spec) =>
        Effect.sync(() => {
          registeredSpec = spec;
          registeredWsl = makeStubInstance({
            id: spec.id,
            label: "WSL",
            snapshot: idleSnapshot,
            start: Effect.sync(() => {
              startCount += 1;
            }),
          });
          return registeredWsl;
        }),
      unregister: () =>
        Effect.sync(() => {
          registeredWsl = undefined;
        }),
    } satisfies DesktopBackendPool.DesktopBackendPool["Service"]);

    return Effect.gen(function* () {
      const backend = yield* DesktopWslBackend.DesktopWslBackend;

      yield* backend.reconcile;
      const spec = registeredSpec;
      assert.isDefined(spec);
      if (spec === undefined) {
        throw new Error("Expected WSL backend registration");
      }
      const recordFailure = spec.onPreflightFailed;
      const recordOwnershipFailure = spec.onStateDirOwned;
      const clearFailure = spec.onReady;
      assert.isDefined(recordFailure);
      assert.isDefined(recordOwnershipFailure);
      assert.isDefined(clearFailure);
      if (
        recordFailure === undefined ||
        recordOwnershipFailure === undefined ||
        clearFailure === undefined
      ) {
        throw new Error("Expected WSL backend callbacks");
      }

      assert.isFalse(yield* recordFailure({ reason: "Node.js not found", fatal: true }));
      assert.deepEqual(yield* backend.lastPreflightError, Option.some("Node.js not found"));

      yield* recordOwnershipFailure();
      const refusal = yield* backend.lastPreflightError;
      assert.include(Option.getOrThrow(refusal), "Another T3 Code server");
      yield* backend.reconcile;
      assert.equal(startCount, 1);
      assert.deepEqual(yield* backend.lastPreflightError, refusal);

      yield* clearFailure(new URL("http://127.0.0.1:41773"));
      assert.deepEqual(yield* backend.lastPreflightError, Option.none());
      yield* recordOwnershipFailure();
      const settings = yield* DesktopAppSettings.DesktopAppSettings;
      yield* settings.setWslDistro("Debian");
      yield* backend.reconcile;
      assert.equal(startCount, 2);
      assert.deepEqual(yield* backend.lastPreflightError, Option.none());
      const nextSpec = registeredSpec;
      if (nextSpec?.onStateDirOwned === undefined) throw new Error("Expected ownership callback");
      yield* nextSpec.onStateDirOwned();
      yield* settings.setWslBackendEnabled(false);
      yield* backend.reconcile;
      yield* settings.setWslBackendEnabled(true);
      yield* backend.reconcile;
      assert.equal(startCount, 3);
      assert.deepEqual(yield* backend.lastPreflightError, Option.none());
    }).pipe(
      Effect.provide(
        DesktopWslBackend.layer.pipe(
          Layer.provideMerge(layerPool),
          Layer.provideMerge(layerBackendConfiguration),
          Layer.provideMerge(layerServerExposure),
          Layer.provideMerge(layerNet),
          Layer.provideMerge(layerHttpClient(() => new Response(null, { status: 500 }))),
          Layer.provideMerge(
            DesktopAppSettings.layerTest({
              ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
              wslBackendEnabled: true,
              wslDistro: "Ubuntu",
              wslOnly: false,
            }),
          ),
          Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: true })),
        ),
      ),
    );
  });

  it.effect.each([
    { name: "a ready primary", ready: true, status: 200, expected: "primary-env" },
    { name: "a primary that never becomes ready", ready: false, status: 200, expected: undefined },
    { name: "a failed descriptor request", ready: true, status: 500, expected: undefined },
  ])("passes the primary environment id to WSL for $name", ({ ready, status, expected }) => {
    let registeredSpec: DesktopBackendPool.BackendInstanceSpec | undefined;
    const resolvedHostIds: Array<EnvironmentId | undefined> = [];
    const primary = makeStubInstance({
      id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
      label: "Windows",
      snapshot: primarySnapshot,
      ready,
    });
    const layerPool = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
      get: () => Effect.succeed(Option.none<DesktopBackendPool.DesktopBackendInstance>()),
      list: Effect.succeed([primary]),
      primary: Effect.succeed(primary),
      register: (spec) =>
        Effect.sync(() => {
          registeredSpec = spec;
          return makeStubInstance({ id: spec.id, label: "WSL", snapshot: idleSnapshot });
        }),
      unregister: () => Effect.void,
    } satisfies DesktopBackendPool.DesktopBackendPool["Service"]);
    const layerConfiguration = Layer.succeed(
      DesktopBackendConfiguration.DesktopBackendConfiguration,
      {
        resolvePrimary: Effect.die("unexpected resolvePrimary"),
        resolvePrimaryLabel: Effect.succeed("Windows"),
        resolveWsl: (input) => {
          resolvedHostIds.push(input.hostEnvironmentId);
          return Effect.die("stop after resolving the host id");
        },
        currentBootstrapToken: Effect.die("unexpected currentBootstrapToken"),
      } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"],
    );

    return Effect.gen(function* () {
      const backend = yield* DesktopWslBackend.DesktopWslBackend;
      yield* backend.reconcile;
      if (registeredSpec === undefined) throw new Error("Expected WSL backend registration");
      yield* Effect.exit(registeredSpec.configResolve);
      assert.deepEqual(resolvedHostIds, [
        expected === undefined ? undefined : EnvironmentId.make(expected),
      ]);
    }).pipe(
      Effect.provide(
        DesktopWslBackend.layer.pipe(
          Layer.provideMerge(layerPool),
          Layer.provideMerge(layerConfiguration),
          Layer.provideMerge(layerServerExposure),
          Layer.provideMerge(layerNet),
          Layer.provideMerge(
            layerHttpClient((url) =>
              url === "http://127.0.0.1:3773/.well-known/t3/environment"
                ? Response.json(primaryDescriptor, { status })
                : new Response(null, { status: 404 }),
            ),
          ),
          Layer.provideMerge(
            DesktopAppSettings.layerTest({
              ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
              wslBackendEnabled: true,
              wslDistro: "Ubuntu",
              wslOnly: false,
            }),
          ),
          Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: true })),
        ),
      ),
    );
  });
});
