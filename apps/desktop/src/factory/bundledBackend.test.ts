import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import { layerDesktopEnvironment } from "./testing.ts";

// Runs the real instance `start` with a config that always fails to resolve, so a start that
// is not skipped returns without spawning and the test only counts what it reached.
const startInstance = (
  id: string,
  environment: ReturnType<typeof layerDesktopEnvironment> | null,
) => {
  const calls = { configResolve: 0, spawn: 0 };
  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        calls.spawn += 1;
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );
  const services = Layer.mergeAll(
    FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
    spawner,
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
      ),
    ),
    Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
      forInstance: () =>
        Effect.succeed({
          beginSession: () => Effect.void,
          writeOutputChunk: () => Effect.void,
          persistFailureSnapshot: () => Effect.void,
          persistFailure: () => Effect.void,
          discardSession: Effect.void,
        }),
    } satisfies DesktopObservability.DesktopBackendOutputLogFactory["Service"]),
    Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
      latest: Effect.succeedNone,
      changes: Stream.empty,
      encoded: Stream.empty,
      handleControlForSource: () => Effect.void,
      removeControlSource: () => Effect.void,
      publishUpdateReport: () => Effect.void,
      updateRequests: Stream.empty,
      updateCommits: Stream.empty,
      updateCancellations: Stream.empty,
    }),
    DesktopBrowserHost.layer,
    DesktopWslEnvironment.layerTest({}),
  );
  const run = Effect.gen(function* () {
    const instance = yield* DesktopBackendManager.makeBackendInstance({
      id: DesktopBackendManager.BackendInstanceId(id),
      label: Effect.succeed("test"),
      configResolve: Effect.sync(() => {
        calls.configResolve += 1;
      }).pipe(
        Effect.andThen(
          Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "test",
              method: "configResolve",
            }),
          ),
        ),
      ),
    });
    yield* instance.start;
    return calls;
  }).pipe(Effect.provide(services), Effect.scoped);
  return environment === null ? run : run.pipe(Effect.provide(environment));
};

const packaged = (baseDir: string) => layerDesktopEnvironment(baseDir, true);
const unpackaged = (baseDir: string) => layerDesktopEnvironment(baseDir, false);

describe("the bundled backend in a fork build", () => {
  it.effect("the primary instance of a packaged build neither resolves its config nor spawns", () =>
    Effect.gen(function* () {
      const calls = yield* startInstance(
        DesktopBackendManager.PRIMARY_INSTANCE_ID,
        packaged("/tmp/factory-bundled-a"),
      );
      assert.deepEqual(calls, { configResolve: 0, spawn: 0 });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a non-primary instance of a packaged build still starts", () =>
    Effect.gen(function* () {
      const calls = yield* startInstance("wsl:default", packaged("/tmp/factory-bundled-b"));
      assert.equal(calls.configResolve, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("the primary instance of a dev build still starts", () =>
    Effect.gen(function* () {
      const calls = yield* startInstance(
        DesktopBackendManager.PRIMARY_INSTANCE_ID,
        unpackaged("/tmp/factory-bundled-c"),
      );
      assert.equal(calls.configResolve, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("the primary instance still starts when no desktop environment is provided", () =>
    Effect.gen(function* () {
      const calls = yield* startInstance(DesktopBackendManager.PRIMARY_INSTANCE_ID, null);
      assert.equal(calls.configResolve, 1);
    }),
  );
});
