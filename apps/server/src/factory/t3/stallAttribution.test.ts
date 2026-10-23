// @effect-diagnostics nodeBuiltinImport:off - the tests read the stall log the layer writes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../../config.ts";
import { useTempDirs } from "../ledger/testSupport.ts";
import { makeWithStallAttribution, withStallAttribution } from "./stallAttribution.ts";

const tempDir = useTempDirs();

const busyWait = (ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Blocks the loop on purpose.
  }
};

const serverConfig = (logsDir: string) =>
  Layer.succeed(ServerConfig.ServerConfig, {
    serverTracePath: NodePath.join(logsDir, "server.trace.ndjson"),
  } as ServerConfig.ServerConfig["Service"]);

describe("withStallAttribution", () => {
  it("replaces the Tracer the decorated layer provides and keeps its other outputs", async () => {
    const logsDir = tempDir();
    const base = await Effect.runPromise(Effect.service(Tracer.Tracer));
    const decorated = withStallAttribution(Layer.succeed(Tracer.Tracer, base));
    const seen = await Effect.runPromise(
      Effect.service(Tracer.Tracer).pipe(
        Effect.provide(decorated),
        Effect.provide(serverConfig(logsDir)),
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    );
    expect(seen).not.toBe(base);
  });

  it("names the spans that were in flight in factory-event-loop-stalls.ndjson, even one that ended before detection", async () => {
    const logsDir = tempDir();
    const base = await Effect.runPromise(Effect.service(Tracer.Tracer));
    const decorated = makeWithStallAttribution({
      intervalMs: 10,
      thresholdMs: 100,
      profile: false,
    })(Layer.succeed(Tracer.Tracer, base));
    const file = NodePath.join(logsDir, "factory-event-loop-stalls.ndjson");

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.sleep("30 millis");
        yield* Effect.sync(() => busyWait(250)).pipe(
          Effect.withSpan("ThreadLaunchService.prepareInBackground", { root: true }),
        );
        for (let i = 0; i < 100 && !NodeFS.existsSync(file); i++) {
          yield* Effect.sleep("20 millis");
        }
      }).pipe(
        Effect.provide(decorated),
        Effect.provide(serverConfig(logsDir)),
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    );

    const lines = NodeFS.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.stallMs).toBeGreaterThanOrEqual(200);
    expect(typeof record.time).toBe("string");
    expect(record.spans.map((s: { name: string }) => s.name)).toContain(
      "ThreadLaunchService.prepareInBackground",
    );
  });
});
