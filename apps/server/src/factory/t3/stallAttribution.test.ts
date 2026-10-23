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

  it.effect(
    "names the child span that blocked, not the long-lived spans that were already open",
    () =>
      Effect.gen(function* () {
        const logsDir = tempDir();
        const base = yield* Effect.service(Tracer.Tracer);
        const decorated = makeWithStallAttribution({
          intervalMs: 10,
          thresholdMs: 100,
          profile: false,
        })(Layer.succeed(Tracer.Tracer, base));
        const warnings = [yield* Deferred.make<string>(), yield* Deferred.make<string>()];
        let warned = 0;
        const capture = Logger.make<unknown, void>(({ message }) => {
          const text = String(Array.isArray(message) ? message[0] : message);
          if (text.startsWith("factory event loop stalled"))
            Deferred.doneUnsafe(warnings[warned++]!, Effect.succeed(text));
        });
        const warning = yield* Effect.gen(function* () {
          // Connection and worker spans that never end, as in a server that has been up a while.
          for (let i = 0; i < 6; i += 1) yield* Effect.makeSpan(`http.server GET /ws ${i}`);
          // The first stall puts a detector tick after those spans started.
          yield* Effect.sync(() => blockThread(150));
          yield* Deferred.await(warnings[0]!);
          yield* Effect.sync(() => blockThread(250)).pipe(
            Effect.withSpan("PullRequestSyncReactor.sweep"),
            Effect.withSpan("PullRequestSyncReactor.run"),
          );
          return yield* Deferred.await(warnings[1]!);
        }).pipe(
          Effect.provide(
            decorated.pipe(
              Layer.provide(Layer.merge(Logger.layer([capture]), serverConfig(logsDir))),
            ),
          ),
          Effect.scoped,
        );
        assert.include(warning, "during the stall: PullRequestSyncReactor.sweep (");
        assert.include(warning, "oldest in flight: http.server GET /ws 0 (");

        const lines = NodeFS.readFileSync(
          NodePath.join(logsDir, "factory-event-loop-stalls.ndjson"),
          "utf8",
        )
          .trim()
          .split("\n");
        assert.strictEqual(lines.length, 2);
        const record = JSON.parse(lines[1]!);
        assert.strictEqual(record.spans[0].name, "PullRequestSyncReactor.sweep");
        assert.deepStrictEqual(
          record.oldestInFlight.map((s: { name: string }) => s.name),
          [0, 1, 2, 3, 4].map((i) => `http.server GET /ws ${i}`),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("profiles the process into stall-profiles/ after a long stall", () =>
    Effect.gen(function* () {
      const logsDir = tempDir();
      const base = yield* Effect.service(Tracer.Tracer);
      const decorated = makeWithStallAttribution({
        intervalMs: 10,
        thresholdMs: 100,
        profileThresholdMs: 200,
        profileDurationMs: 50,
      })(Layer.succeed(Tracer.Tracer, base));
      const written = yield* Deferred.make<void>();
      const capture = Logger.make<unknown, void>(({ message }) => {
        const text = String(Array.isArray(message) ? message[0] : message);
        if (text === "factory stall profile written") Deferred.doneUnsafe(written, Effect.void);
      });
      yield* Effect.gen(function* () {
        yield* Effect.sync(() => blockThread(250));
        yield* Deferred.await(written);
      }).pipe(
        Effect.provide(
          decorated.pipe(
            Layer.provide(Layer.merge(Logger.layer([capture]), serverConfig(logsDir))),
          ),
        ),
        Effect.scoped,
      );
      const profiles = NodeFS.readdirSync(NodePath.join(logsDir, "stall-profiles"));
      assert.strictEqual(profiles.length, 1);
      assert.match(profiles[0]!, /\.cpuprofile$/);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
