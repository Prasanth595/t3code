// @effect-diagnostics nodeBuiltinImport:off -- Real inherited pipes and process exits are the behavior under test.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { describe, expect } from "vite-plus/test";

const BACKEND_SCRIPT = `
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
const { layer } = await import(process.env.T3_TEST_DESKTOP_LIFETIME_MODULE);
const { ServerConfig } = await import(new URL("./config.ts", process.env.T3_TEST_DESKTOP_LIFETIME_MODULE));
const report = (line) => NodeFS.writeSync(1, line + "\\n");
process.stdin.on("data", () => report("alive"));
NodeRuntime.runMain(Effect.gen(function* () {
  yield* Effect.acquireRelease(
    Effect.promise(() => new Promise((resolve) => {
      const server = NodeNet.createServer();
      server.listen(0, "127.0.0.1", () => resolve(server));
    })),
    (server) => Effect.promise(() => new Promise((resolve) => {
      server.close(() => { report("finalized"); resolve(); });
    })),
  );
  yield* Layer.build(layer);
  report("ready");
  yield* Effect.never;
}).pipe(
  Effect.scoped,
  Effect.provide(Layer.mock(ServerConfig)({
    desktopLifetimeFd: process.env.T3_TEST_LIFETIME_FD === "8" ? 8 : undefined,
  })),
));
`;

const spawnFixture = Effect.fn(function* (script: string, options: NodeChildProcess.SpawnOptions) {
  const lines = yield* Queue.unbounded<string>();
  return yield* Effect.acquireRelease(
    Effect.sync(() => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          cwd: NodePath.join(import.meta.dirname, ".."),
          ...options,
        },
      );
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => resolve({ code, signal }));
        },
      );
      if (!child.stdout) throw new Error("Fixture requires stdout");
      const output = NodeReadline.createInterface({ input: child.stdout });
      output.on("line", (line) => Queue.offerUnsafe(lines, line));
      output.once("close", () => Queue.offerUnsafe(lines, "stdout closed"));
      return { child, exited, lines, output };
    }),
    ({ child, exited, output }) =>
      Effect.promise(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        output.close();
      }),
  );
});

const takeLine = (lines: Queue.Dequeue<string>, expected: string) =>
  Queue.take(lines).pipe(
    Effect.repeat({ until: (line) => line === expected || line === "stdout closed" }),
    Effect.tap((line) => Effect.sync(() => expect(line).toBe(expected))),
  );

// Passing the writer to another child uses inherited POSIX descriptors.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("DesktopLifetime", () => {
  it.effect.each([8, undefined])(
    "only shuts down with the desktop when its lifetime descriptor is configured: %s",
    (desktopLifetimeFd) =>
      Effect.gen(function* () {
        const backend = yield* spawnFixture(BACKEND_SCRIPT, {
          env: {
            ...process.env,
            T3_TEST_LIFETIME_FD: String(desktopLifetimeFd),
            T3_TEST_DESKTOP_LIFETIME_MODULE: NodeURL.pathToFileURL(
              NodePath.join(import.meta.dirname, "desktopLifetime.ts"),
            ).href,
          },
          stdio: ["pipe", "pipe", "inherit", "ignore", "pipe", "pipe", "pipe", "pipe", "pipe"],
        });
        const lifetimePipe = backend.child.stdio.at(8);
        if (!lifetimePipe) throw new Error("Missing lifetime pipe");

        // The stand-in desktop owns the sole writer. Keeping the backend as our
        // direct child lets us observe and reap its actual exit, including on failure.
        const desktop = yield* spawnFixture('process.stdin.resume(); console.log("ready");', {
          stdio: ["pipe", "pipe", "inherit", lifetimePipe],
        });
        lifetimePipe.destroy();
        yield* takeLine(desktop.lines, "ready");

        // Close unused pipe endpoints; FD 8 remains owned by the desktop fixture.
        for (const fd of [4, 5, 6, 7]) backend.child.stdio[fd]?.destroy();
        yield* takeLine(backend.lines, "ready");
        backend.child.stdin?.write("ping");
        yield* takeLine(backend.lines, "alive");

        desktop.child.kill("SIGKILL");
        expect(yield* Effect.promise(() => desktop.exited)).toEqual({
          code: null,
          signal: "SIGKILL",
        });
        if (desktopLifetimeFd === undefined) {
          backend.child.stdin?.write("ping");
          yield* takeLine(backend.lines, "alive");
          backend.child.kill("SIGTERM");
        }

        yield* takeLine(backend.lines, "finalized");
        expect(yield* Effect.promise(() => backend.exited)).toEqual({ code: 130, signal: null });
      }),
    { timeout: 15_000 },
  );
});
