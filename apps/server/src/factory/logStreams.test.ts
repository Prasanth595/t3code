// @effect-diagnostics nodeBuiltinImport:off - the guard patches real Node streams, and a child process proves it.
import * as NodeChildProcess from "node:child_process";
import { Console } from "node:console";
import * as NodePath from "node:path";
import { Writable } from "node:stream";
import * as NodeURL from "node:url";

import { assert } from "@effect/vitest";
import { describe, it } from "vite-plus/test";

import { guardLogStream } from "./logStreams.ts";

const factoryDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
/** The module server.ts imports for FactoryLayer. */
const factoryModule = NodeURL.pathToFileURL(NodePath.join(factoryDir, "index.ts")).href;

const enospc = () =>
  Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });

/** Lets a stream emit the error it queued on the next tick. */
const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("guardLogStream", () => {
  it("drops lines while the disk is full and says how many on the first write that succeeds", async () => {
    let full = true;
    const fd: Array<string> = [];
    // Fails the way a log file on a full disk does: the write calls back with ENOSPC, which the
    // stream emits as an `error` event on the next tick.
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback(full ? enospc() : null);
      },
    });
    guardLogStream(stream, 1, (_fd, data) => {
      if (full) throw enospc();
      fd.push(String(data));
    });
    const log = new Console(stream);

    log.log("one");
    log.log("two");
    await nextMacrotask();
    log.log("three");
    await nextMacrotask();
    // A writer that waits on its callback is not left hanging by a dropped line.
    const written = await new Promise((resolve) => stream.write("four\n", resolve));
    assert.isUndefined(written);
    const encoded = await new Promise((resolve) => stream.write("five\n", "utf8", resolve));
    assert.isUndefined(encoded);
    assert.deepEqual(fd, []);

    full = false;
    log.log("back");
    log.log("again");
    assert.deepEqual(fd, ["5 log lines dropped (ENOSPC)\n", "back\n", "again\n"]);
  });

  // The guard is in place as soon as server.ts imports the factory, before any layer builds, so a
  // full disk during startup cannot end the server either.
  it("keeps a process that imported the factory alive when its stdout pipe has closed", async () => {
    const script = [
      `await import(${JSON.stringify(factoryModule)});`,
      `for (let i = 0; i < 50; i++) {`,
      `  console.log("line " + i);`,
      `  await new Promise((resolve) => setImmediate(resolve));`,
      `}`,
      `process.stderr.write("alive\\n");`,
    ].join("\n");
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["--input-type=module", "--no-warnings", "-e", script],
      {
        cwd: NodePath.resolve(factoryDir, "../.."),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
    // Nobody reads stdout, so every write the child makes to it fails with EPIPE.
    child.stdout.destroy();
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text));
    const [status, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.on("close", (code, killed) => resolve([code, killed])),
    );
    assert.deepStrictEqual([status, signal], [0, null], stderr);
    assert.strictEqual(stderr, "alive\n");
  });
});
