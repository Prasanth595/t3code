import {
  UsageLimitSourceAccount,
  UsageLimitSourceError,
  type CommandUsageLimitSourceConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;

const CommandAccountsOutput = Schema.Struct({
  accounts: Schema.Array(UsageLimitSourceAccount),
});
const decodeCommandOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CommandAccountsOutput),
);

/**
 * Runs a `kind: "command"` usage-limit source. The command owns credential
 * lookup itself — T3 only reads the `{ "accounts": [...] }` JSON document it
 * prints on stdout.
 */
export const makeCommandApi = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const readAccounts = Effect.fn("CommandApi.readAccounts")(function* (
    config: CommandUsageLimitSourceConfig,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(config.command, [...config.args], {
            forceKillAfter: "1 second",
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.take(MAX_STDOUT_BYTES), Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(Stream.take(MAX_STDERR_BYTES), Stream.decodeText(), Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, exitCode };
      }),
    ).pipe(
      Effect.timeout(COMMAND_TIMEOUT_MS),
      Effect.mapError((cause) => {
        const detail = Cause.isTimeoutError(cause)
          ? `The command did not finish within ${COMMAND_TIMEOUT_MS / 1000} seconds.`
          : `The command could not be run (${config.command}): ${cause instanceof Error ? cause.message : String(cause)}`;
        return new UsageLimitSourceError({ detail });
      }),
    );

    if (result.exitCode !== 0) {
      const stderrTail = result.stderr.trim().split("\n").pop();
      return yield* new UsageLimitSourceError({
        detail: `The command failed with exit code ${result.exitCode}.${stderrTail ? ` ${stderrTail}` : ""}`,
      });
    }

    const output = yield* decodeCommandOutput(result.stdout).pipe(
      Effect.mapError(
        () =>
          new UsageLimitSourceError({
            detail:
              'The command\'s output is not valid usage-limit JSON (expected { "accounts": [...] }).',
          }),
      ),
    );
    return output.accounts;
  });

  return { readAccounts };
});
