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
 * Runs `exitProcess(fallbackMs)` in a child whose SIGTERM handler is `onSigterm`, and returns the
 * child's exit code. The child would otherwise exit 7 after 5 seconds, so a hang is a failure, not
 * a timeout.
 */
const exitCodeOf = (onSigterm: string, fallbackMs: number) => {
  const script = [
    `import { exitProcess } from ${JSON.stringify(exitModule)};`,
    `process.on("SIGTERM", ${onSigterm});`,
    `setTimeout(() => process.exit(7), 5000);`,
    `exitProcess(${fallbackMs});`,
  ].join("\n");
  const child = NodeChildProcess.spawnSync(
    process.execPath,
    ["--input-type=module", "--no-warnings", "-e", script],
    { encoding: "utf8", timeout: 15_000 },
  );
  return { status: child.status, stderr: child.stderr };
};

describe("exitProcess", () => {
  it("exits 0 through the SIGTERM path even though runMain's teardown exits 130", () => {
    const child = exitCodeOf("() => process.exit(130)", 10_000);
    assert.strictEqual(child.status, 0, child.stderr);
  });

  it("exits 0 after the fallback when the shutdown hangs", () => {
    const child = exitCodeOf("() => {}", 200);
    assert.strictEqual(child.status, 0, child.stderr);
  });
});
