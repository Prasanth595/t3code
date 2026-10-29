import { assert, describe, it } from "@effect/vitest";
import {
  type VcsError,
  VcsProcessExitError,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import type { VcsProcessInput, VcsProcessOutput } from "../../vcs/VcsProcess.ts";
import { decorate } from "./ghCredentialProcess.ts";

const TOKEN = "gho_fakeTokenThatMustNeverBeLogged";

const credentialInput: VcsProcessInput = {
  operation: "GitHubCredentials.get",
  command: "gh",
  args: ["auth", "token", "--hostname", "github.com"],
  cwd: "/work",
  timeoutMs: 10_000,
};

const base = { operation: "GitHubCredentials.get", command: "gh", cwd: "/work" };
const timeout = (timeoutMs = 10_000) => new VcsProcessTimeoutError({ ...base, timeoutMs });
const exitError = new VcsProcessExitError({
  ...base,
  exitCode: 1,
  detail: "no oauth token",
  failureKind: "authentication",
});
const spawnError = new VcsProcessSpawnError({ ...base, cause: new Error("ENOENT") });

const success: VcsProcessOutput = {
  exitCode: 0 as VcsProcessOutput["exitCode"],
  stdout: `${TOKEN}\n`,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};

type Reply = { readonly _tag: "ok" } | { readonly _tag: "fail"; readonly error: VcsError };
const ok: Reply = { _tag: "ok" };
const fail = (error: VcsError): Reply => ({ _tag: "fail", error });

/** An inner VcsProcess that answers each call with the next scripted reply and records its input. */
const fakeInner = (replies: Array<Reply>) => {
  const calls: Array<VcsProcessInput> = [];
  const run = (input: VcsProcessInput) =>
    Effect.suspend(() => {
      calls.push(input);
      const reply = replies.shift();
      if (reply === undefined) return Effect.die(new Error("unexpected inner run"));
      return reply._tag === "ok" ? Effect.succeed(success) : Effect.fail(reply.error);
    });
  return { calls, service: { run } };
};

/** Every log line the effect writes, message and annotations, as text. */
const captureLogs = () => {
  const lines: Array<string> = [];
  const logger = Logger.make<unknown, void>(({ message, logLevel }) => {
    lines.push(`${logLevel} ${JSON.stringify(message)}`);
  });
  return { lines, layer: Logger.layer([logger]) };
};

describe("ghCredentialProcess.decorate", () => {
  it.effect("(a) retries a timed-out credential lookup once with a 30 s timeout", () =>
    Effect.gen(function* () {
      const inner = fakeInner([fail(timeout()), ok]);
      const decorated = decorate(inner.service);
      const output = yield* decorated.run(credentialInput);
      assert.strictEqual(output.stdout, success.stdout);
      assert.strictEqual(inner.calls.length, 2);
      assert.strictEqual(inner.calls[1]!.timeoutMs, 30_000);
      assert.deepStrictEqual({ ...inner.calls[1]!, timeoutMs: 10_000 }, credentialInput);
    }),
  );

  it.effect(
    "(b) reuses the output read 10 min earlier after two timeouts, and warns once without the token",
    () =>
      Effect.gen(function* () {
        const logs = captureLogs();
        const inner = fakeInner([ok, fail(timeout()), fail(timeout(30_000))]);
        const decorated = decorate(inner.service);
        yield* decorated.run(credentialInput);
        yield* TestClock.adjust("10 minutes");
        const output = yield* decorated.run(credentialInput).pipe(Effect.provide(logs.layer));
        assert.strictEqual(output.stdout, success.stdout);
        assert.strictEqual(inner.calls.length, 3);
        const warnings = logs.lines.filter((line) => line.startsWith("Warn"));
        assert.strictEqual(warnings.length, 1);
        assert.include(
          warnings[0]!,
          "gh credential lookup timed out twice; reusing the credential read 600 s ago",
        );
        assert.include(warnings[0]!, "github.com");
        // (f) the token is in no captured line.
        assert.isFalse(logs.lines.some((line) => line.includes(TOKEN)));
      }),
  );

  it.effect("(c) fails with the timeout when the last success is 31 min old", () =>
    Effect.gen(function* () {
      const inner = fakeInner([ok, fail(timeout()), fail(timeout(30_000))]);
      const decorated = decorate(inner.service);
      yield* decorated.run(credentialInput);
      yield* TestClock.adjust("31 minutes");
      const error = yield* Effect.flip(decorated.run(credentialInput));
      assert.deepStrictEqual(error, timeout(30_000));
    }),
  );

  it.effect("(c) fails with the timeout when there was never a success", () =>
    Effect.gen(function* () {
      const inner = fakeInner([fail(timeout()), fail(timeout(30_000))]);
      const error = yield* Effect.flip(decorate(inner.service).run(credentialInput));
      assert.deepStrictEqual(error, timeout(30_000));
      assert.strictEqual(inner.calls.length, 2);
    }),
  );

  it.effect("keeps the last-good output per command and args, not per host", () =>
    Effect.gen(function* () {
      const inner = fakeInner([ok, fail(timeout()), fail(timeout(30_000))]);
      const decorated = decorate(inner.service);
      yield* decorated.run(credentialInput);
      const other = { ...credentialInput, args: ["auth", "token", "--hostname", "acme.ghe.com"] };
      const error = yield* Effect.flip(decorated.run(other));
      assert.deepStrictEqual(error, timeout(30_000));
    }),
  );

  it.effect(
    "(d) propagates an exit error with no retry and forgets the output, so a later double timeout fails",
    () =>
      Effect.gen(function* () {
        const inner = fakeInner([ok, fail(exitError), fail(timeout()), fail(timeout(30_000))]);
        const decorated = decorate(inner.service);
        yield* decorated.run(credentialInput);
        const exited = yield* Effect.flip(decorated.run(credentialInput));
        assert.deepStrictEqual(exited, exitError);
        assert.strictEqual(inner.calls.length, 2);
        const timedOut = yield* Effect.flip(decorated.run(credentialInput));
        assert.deepStrictEqual(timedOut, timeout(30_000));
      }),
  );

  it.effect("(d) propagates a spawn error with no retry and forgets the output", () =>
    Effect.gen(function* () {
      const inner = fakeInner([ok, fail(spawnError), fail(timeout()), fail(timeout(30_000))]);
      const decorated = decorate(inner.service);
      yield* decorated.run(credentialInput);
      const spawned = yield* Effect.flip(decorated.run(credentialInput));
      assert.deepStrictEqual(spawned, spawnError);
      assert.strictEqual(inner.calls.length, 2);
      const timedOut = yield* Effect.flip(decorated.run(credentialInput));
      assert.deepStrictEqual(timedOut, timeout(30_000));
    }),
  );

  it.effect("(d) forgets the output when the retry after a timeout exits non-zero", () =>
    Effect.gen(function* () {
      const inner = fakeInner([
        ok,
        fail(timeout()),
        fail(exitError),
        fail(timeout()),
        fail(timeout(30_000)),
      ]);
      const decorated = decorate(inner.service);
      yield* decorated.run(credentialInput);
      assert.deepStrictEqual(yield* Effect.flip(decorated.run(credentialInput)), exitError);
      assert.deepStrictEqual(yield* Effect.flip(decorated.run(credentialInput)), timeout(30_000));
    }),
  );

  it.effect("(e) passes another operation's timeout through with one inner call", () =>
    Effect.gen(function* () {
      const gitTimeout = new VcsProcessTimeoutError({
        operation: "GitVcsDriver.execute",
        command: "git",
        cwd: "/work",
        timeoutMs: 30_000,
      });
      const inner = fakeInner([fail(gitTimeout)]);
      const input: VcsProcessInput = {
        operation: "GitVcsDriver.execute",
        command: "git",
        args: ["status"],
        cwd: "/work",
      };
      const error = yield* Effect.flip(decorate(inner.service).run(input));
      assert.deepStrictEqual(error, gitTimeout);
      assert.strictEqual(inner.calls.length, 1);
      assert.strictEqual(inner.calls[0], input);
    }),
  );
});
