import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as VcsProcess from "../../vcs/VcsProcess.ts";

const CREDENTIAL_OPERATION = "GitHubCredentials.get";
const RETRY_TIMEOUT_MS = 30_000;
const LAST_GOOD_MAX_AGE_MS = 30 * 60_000;

const hostOf = (args: ReadonlyArray<string>) => {
  const at = args.indexOf("--hostname");
  return at === -1 ? undefined : args[at + 1];
};

/**
 * For `GitHubCredentials.get` only: retry a timeout once at 30 s, then reuse the last success
 * for the same command and args if it is at most 30 minutes old. Other failures forget it.
 * The remembered output carries the token: memory only, never logged.
 */
export const decorate = (
  inner: VcsProcess.VcsProcess["Service"],
): VcsProcess.VcsProcess["Service"] => {
  const lastGood = new Map<
    string,
    { readonly output: VcsProcess.VcsProcessOutput; readonly atMs: number }
  >();

  const run = (input: VcsProcess.VcsProcessInput) => {
    if (input.operation !== CREDENTIAL_OPERATION) return inner.run(input);
    const key = JSON.stringify([input.command, ...input.args]);
    return inner.run(input).pipe(
      Effect.catchTags({
        VcsProcessTimeoutError: () => inner.run({ ...input, timeoutMs: RETRY_TIMEOUT_MS }),
      }),
      Effect.tap((output) =>
        Clock.currentTimeMillis.pipe(Effect.map((atMs) => lastGood.set(key, { output, atMs }))),
      ),
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (error._tag !== "VcsProcessTimeoutError") {
            lastGood.delete(key);
            return yield* error;
          }
          const remembered = lastGood.get(key);
          if (remembered === undefined) return yield* error;
          const ageMs = (yield* Clock.currentTimeMillis) - remembered.atMs;
          if (ageMs > LAST_GOOD_MAX_AGE_MS) return yield* error;
          const ageSeconds = Math.round(ageMs / 1000);
          yield* Effect.logWarning(
            `gh credential lookup timed out twice; reusing the credential read ${ageSeconds} s ago`,
            { host: hostOf(input.args), ageSeconds },
          );
          return remembered.output;
        }),
      ),
    );
  };

  return VcsProcess.VcsProcess.of({ run });
};

/** Upstream's VcsProcess with `GitHubCredentials.get` decorated; server.ts provides this one. */
export const layer = Layer.effect(
  VcsProcess.VcsProcess,
  Effect.map(Effect.service(VcsProcess.VcsProcess), decorate),
).pipe(Layer.provide(VcsProcess.layer));
