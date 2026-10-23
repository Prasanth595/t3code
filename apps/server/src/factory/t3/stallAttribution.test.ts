// @effect-diagnostics nodeBuiltinImport:off - the tests read the stall log the layer writes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";

import * as ServerConfig from "../../config.ts";
import { useTempDirs } from "../ledger/testSupport.ts";
import { makeWithStallAttribution, withStallAttribution } from "./stallAttribution.ts";

const tempDir = useTempDirs();

/** Blocks this thread for `ms` without reading a clock. */
const blockThread = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const serverConfig = (logsDir: string) =>
  Layer.succeed(ServerConfig.ServerConfig, {
    serverTracePath: NodePath.join(logsDir, "server.trace.ndjson"),
  } as ServerConfig.ServerConfig["Service"]);

describe("withStallAttribution", () => {
  it.effect("replaces the Tracer the decorated layer provides", () =>
    Effect.gen(function* () {
      const base = yield* Effect.service(Tracer.Tracer);
      const seen = yield* Effect.service(Tracer.Tracer).pipe(
        Effect.provide(
          withStallAttribution(Layer.succeed(Tracer.Tracer, base)).pipe(
            Layer.provide(serverConfig(tempDir())),
          ),
        ),
        Effect.scoped,
      );
      assert.notStrictEqual(seen, base);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "names the spans in flight during a stall in the warning and in factory-event-loop-stalls.ndjson, even one that ended before detection",
    () =>
      Effect.gen(function* () {
        const logsDir = tempDir();
        const base = yield* Effect.service(Tracer.Tracer);
        const decorated = makeWithStallAttribution({
          intervalMs: 10,
          thresholdMs: 100,
          profile: false,
        })(Layer.succeed(Tracer.Tracer, base));
        const warned = yield* Deferred.make<string>();
        const capture = Logger.make<unknown, void>(({ message }) => {
          const text = String(Array.isArray(message) ? message[0] : message);
          if (text.startsWith("factory event loop stalled"))
            Deferred.doneUnsafe(warned, Effect.succeed(text));
        });
        const warning = yield* Effect.gen(function* () {
          yield* Effect.sync(() => blockThread(250)).pipe(
            Effect.withSpan("ThreadLaunchService.prepareInBackground", { root: true }),
          );
          return yield* Deferred.await(warned);
        }).pipe(
          Effect.provide(
            decorated.pipe(
              Layer.provide(Layer.merge(Logger.layer([capture]), serverConfig(logsDir))),
            ),
          ),
          Effect.scoped,
        );
        assert.include(warning, "ThreadLaunchService.prepareInBackground");

        const lines = NodeFS.readFileSync(
          NodePath.join(logsDir, "factory-event-loop-stalls.ndjson"),
          "utf8",
        )
          .trim()
          .split("\n");
        assert.strictEqual(lines.length, 1);
        const record = JSON.parse(lines[0]!);
        assert.isAtLeast(record.stallMs, 200);
        assert.strictEqual(typeof record.time, "string");
        assert.include(
          record.spans.map((s: { name: string }) => s.name),
          "ThreadLaunchService.prepareInBackground",
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
