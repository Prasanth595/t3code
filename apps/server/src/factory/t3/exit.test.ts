// @effect-diagnostics nodeBuiltinImport:off - the exit ends a process, so it is proven on a child process.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";

import { assert } from "@effect/vitest";
import { describe, it } from "vite-plus/test";

const exitModule = NodeUrl.pathToFileURL(
  NodePath.join(NodePath.dirname(NodeUrl.fileURLToPath(import.meta.url)), "exit.ts"),
).href;

/**
 * Runs `exitProcess(fallbackMs)` in a child whose SIGTERM handler prints `sigterm` and then runs
 * `onSigterm`, and returns how the child ended. A child still up after 5 seconds is killed with
 * SIGKILL, which no `exit` listener can turn into a 0, so a hang is a failure, not a timeout.
 */
const run = (onSigterm: string, fallbackMs: number) => {
  const script = [
    `import { exitProcess } from ${JSON.stringify(exitModule)};`,
    `process.on("SIGTERM", () => { process.stdout.write("sigterm\\n"); (${onSigterm})(); });`,
    `setTimeout(() => process.kill(process.pid, "SIGKILL"), 5000);`,
    `exitProcess(${fallbackMs});`,
  ].join("\n");
  const child = NodeChildProcess.spawnSync(
    process.execPath,
    ["--input-type=module", "--no-warnings", "-e", script],
    { encoding: "utf8", timeout: 15_000 },
  );
  return { status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr };
};

describe("exitProcess", () => {
  it("sends SIGTERM and exits 0 even though runMain's teardown exits 130 for it", () => {
    const child = run("() => process.exit(130)", 10_000);
    assert.strictEqual(child.stdout, "sigterm\n", child.stderr);
    assert.deepStrictEqual([child.status, child.signal], [0, null], child.stderr);
  });

  it("exits 0 through the fallback when the SIGTERM shutdown hangs", () => {
    const child = run("() => {}", 200);
    assert.strictEqual(child.stdout, "sigterm\n", child.stderr);
    assert.deepStrictEqual([child.status, child.signal], [0, null], child.stderr);
  });
});
