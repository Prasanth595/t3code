// @effect-diagnostics nodeBuiltinImport:off - Tests write pid files to a temp dir and probe process liveness with kill(pid, 0).
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { RunSpawnError, run } from "./process.ts";

const withEnv = <A, E, R>(
  vars: Record<string, string>,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const saved = Object.keys(vars).map((k) => [k, globalThis.process.env[k]] as const);
      for (const [k, v] of Object.entries(vars)) globalThis.process.env[k] = v;
      return saved;
    }),
    () => body,
    (saved) =>
      Effect.sync(() => {
        for (const [k, v] of saved) {
          if (v === undefined) delete globalThis.process.env[k];
          else globalThis.process.env[k] = v;
        }
      }),
  );

const isAlive = (pid: number): boolean => {
  try {
    globalThis.process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// 16384 lines of 65 bytes each, about 1 MiB, with a counter so the tail is checkable.
const COUNTER_SCRIPT = `i=0; while [ $i -lt 16384 ]; do printf '%064d\\n' $i; i=$((i+1)); done`;
const counterOutput = (): string => {
  let out = "";
  for (let i = 0; i < 16384; i++) out += `${String(i).padStart(64, "0")}\n`;
  return out;
};

it.live("does not pass variables outside the allowlist", () =>
  withEnv(
    { FACTORY_PROCESS_TEST_SECRET: "leak" },
    Effect.gen(function* () {
      const result = yield* run({
        command: `printf %s "\${FACTORY_PROCESS_TEST_SECRET-unset}"`,
        shell: true,
      });
      assert.strictEqual(result.tail, "unset");
    }),
  ),
);

it.live("passes PATH, LC_* and the env argument through", () =>
  withEnv(
    { LC_FACTORY_TEST: "lc" },
    Effect.gen(function* () {
      const path = yield* run({ command: `printf %s "$PATH"`, shell: true });
      assert.strictEqual(path.tail, globalThis.process.env.PATH ?? "");
      const lc = yield* run({ command: `printf %s "$LC_FACTORY_TEST"`, shell: true });
      assert.strictEqual(lc.tail, "lc");
      const extra = yield* run({
        command: `printf %s "$FACTORY_PROCESS_TEST_EXTRA"`,
        shell: true,
        env: { FACTORY_PROCESS_TEST_EXTRA: "yes" },
      });
      assert.strictEqual(extra.tail, "yes");
    }),
  ),
);

it.live("a timeout kills the whole process group, grandchild included", () =>
  Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "factory-process-"));
    const pidFile = NodePath.join(dir, "pid");
    const started = Date.now();
    const result = yield* run({
      command: `sleep 100 & echo $! > "$0"; sleep 100`,
      args: [pidFile],
      shell: true,
      timeoutMs: 300,
    });
    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.exitCode, null);
    assert.isBelow(Date.now() - started, 5000);

    const pid = Number(NodeFS.readFileSync(pidFile, "utf8").trim());
    assert.isAbove(pid, 0);
    for (let i = 0; i < 40 && isAlive(pid); i++) yield* Effect.sleep("50 millis");
    assert.strictEqual(isAlive(pid), false);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }),
);

it.live("escalates to SIGKILL when SIGTERM is ignored", () =>
  Effect.gen(function* () {
    const started = Date.now();
    const result = yield* run({
      command: `trap '' TERM; sleep 100`,
      shell: true,
      timeoutMs: 200,
      termGraceMs: 300,
    });
    assert.strictEqual(result.timedOut, true);
    assert.isBelow(Date.now() - started, 5000);
  }),
);

it.live("keeps only the last tailBytes of a 1 MB output", () =>
  Effect.gen(function* () {
    const expected = counterOutput();
    const small = yield* run({ command: COUNTER_SCRIPT, shell: true, tailBytes: 4096 });
    assert.strictEqual(small.tail, expected.slice(-4096));
    assert.strictEqual(small.tail.length, 4096);

    const dflt = yield* run({ command: COUNTER_SCRIPT, shell: true });
    assert.strictEqual(dflt.tail, expected.slice(-16384));
    assert.strictEqual(dflt.tail.length, 16384);
  }),
);

it.live("passes the exit code through", () =>
  Effect.gen(function* () {
    const failed = yield* run({ command: "exit 3", shell: true });
    assert.strictEqual(failed.exitCode, 3);
    assert.strictEqual(failed.timedOut, false);
    const ok = yield* run({ command: "true" });
    assert.strictEqual(ok.exitCode, 0);
  }),
);

it.live("interleaves stdout and stderr in order", () =>
  Effect.gen(function* () {
    const result = yield* run({ command: "echo out1; echo err1 >&2; echo out2", shell: true });
    assert.strictEqual(result.tail, "out1\nerr1\nout2\n");
  }),
);

it.live("runs argv without a shell", () =>
  Effect.gen(function* () {
    const result = yield* run({ command: "printf", args: ["%s-%s", "a", "b"] });
    assert.strictEqual(result.tail, "a-b");
  }),
);

it.live("fails with RunSpawnError when the cwd does not exist", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      run({ command: "true", cwd: "/nonexistent/factory-process-test" }),
    );
    assert.instanceOf(error, RunSpawnError);
  }),
);
