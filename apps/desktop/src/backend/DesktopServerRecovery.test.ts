// @effect-diagnostics nodeBuiltinImport:off - The suite runs real child processes to prove the
// recovery stops a stranded server and leaves everything else alone. The fixtures are isolated
// temporary scripts; no desktop session or user state is touched.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import * as DesktopServerOwnership from "./DesktopServerOwnership.ts";
import { recoverStrandedServer } from "./DesktopServerRecovery.ts";

/**
 * A fixture that has not announced itself yet.
 */
class FixtureNotReadyError extends Schema.TaggedError<FixtureNotReadyError>()(
  "FixtureNotReadyError",
  {},
) {
  override get message(): string {
    return "The backend fixture has not announced itself yet.";
  }
}

const IGNORE_SIGTERM_SOURCE = [
  'import * as NodeFS from "node:fs";',
  'const log = (m) => NodeFS.writeSync(NodeFS.openSync(process.env.FIXTURE_LOG, "a"), m + String.fromCharCode(10));',
  'log("started pid=" + process.pid);',
  'process.on("SIGTERM", () => log("SIGTERM"));',
  'process.on("SIGINT", () => log("SIGINT"));',
  "setInterval(() => {}, 200);",
  "",
].join("\n");

const COOPERATIVE_SOURCE = [
  'import * as NodeFS from "node:fs";',
  'const log = (m) => NodeFS.writeSync(NodeFS.openSync(process.env.FIXTURE_LOG, "a"), m + String.fromCharCode(10));',
  'log("started pid=" + process.pid);',
  'process.on("SIGTERM", () => { log("SIGTERM"); process.exit(0); });',
  "setInterval(() => {}, 200);",
  "",
].join("\n");

interface Fixture {
  readonly log: string;
  readonly pid: number;
}

const spawnFixture = (source: string): Fixture => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-recovery-fixture-"));
  const script = NodePath.join(dir, "backend.mjs");
  const log = NodePath.join(dir, "fixture.log");
  NodeFS.writeFileSync(script, source);
  const child = NodeChildProcess.spawn(process.execPath, [script], {
    stdio: "ignore",
    env: { ...process.env, FIXTURE_LOG: log },
    detached: true,
  });
  return { log, pid: child.pid ?? -1 };
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const readFixtureLog = (logPath: string): string =>
  NodeFS.existsSync(logPath) ? NodeFS.readFileSync(logPath, "utf8") : "";

/** Wait for the fixture to announce itself by writing its first log line. */
const awaitFixtureLog = (logPath: string): Effect.Effect<string> =>
  Effect.sync(() => readFixtureLog(logPath)).pipe(
    Effect.flatMap((log) =>
      log.length > 0
        ? Effect.succeed(log)
        : Effect.yieldNow.pipe(Effect.andThen(Effect.fail(new FixtureNotReadyError()))),
    ),
    Effect.retry({ times: 5_000 }),
    Effect.catchCause(() => Effect.succeed(readFixtureLog(logPath))),
  );

const strandedOwner = (
  pid: number,
): Extract<DesktopServerOwnership.DesktopServerOwner, { readonly _tag: "stranded" }> => ({
  _tag: "stranded",
  record: {
    version: 1,
    pid,
    port: 3773,
    origin: "http://127.0.0.1:3773",
    startedAt: "1970-01-01T00:00:00.000Z",
  },
});

describe("DesktopServerRecovery", () => {
  it.live("stops a stranded server that ignores SIGTERM", () =>
    Effect.gen(function* () {
      const fixture = spawnFixture(IGNORE_SIGTERM_SOURCE);
      yield* awaitFixtureLog(fixture.log);
      assert.isTrue(isProcessAlive(fixture.pid), "the fixture must be running");

      const recovered = yield* recoverStrandedServer({ owner: strandedOwner(fixture.pid) });

      assert.isTrue(recovered, "the recovery must report that the server was stopped");
      assert.isFalse(isProcessAlive(fixture.pid), "the stranded server must be gone");
      assert.include(
        readFixtureLog(fixture.log),
        "SIGTERM",
        "the recovery must try the graceful signal first",
      );
    }),
  );

  it.live("stops a stranded server that shuts down cleanly", () =>
    Effect.gen(function* () {
      const fixture = spawnFixture(COOPERATIVE_SOURCE);
      yield* awaitFixtureLog(fixture.log);
      assert.isTrue(isProcessAlive(fixture.pid), "the fixture must be running");

      const recovered = yield* recoverStrandedServer({ owner: strandedOwner(fixture.pid) });

      assert.isTrue(recovered, "the recovery must report that the server was stopped");
      assert.isFalse(isProcessAlive(fixture.pid), "the stranded server must be gone");
    }),
  );
});
