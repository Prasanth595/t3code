/**
 * The pass loop: one pass when the factory starts and one every `poll_seconds` after, with a
 * wake that starts the next pass now. Passes never overlap: one fiber runs them one after the
 * other, and a wake that arrives during a pass makes the next pass follow it at once, however
 * many wakes arrived. A pass that runs past `PASS_TIMEOUT` is stopped and logged, so one hung
 * call cannot stop every later pass; the next pass goes on from the ledger.
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import type * as Scope from "effect/Scope";

import type { Report } from "./pass.ts";

export interface Loop {
  /** Starts the next pass now when none is running, or right after the one that is. */
  readonly wake: Effect.Effect<void>;
  /** The report of the next pass to finish; null when that pass died or timed out. */
  readonly awaitPass: Effect.Effect<Report | null>;
}

/**
 * Well past what a pass takes, though not a sum of every call's own limit (a `gh` call 60
 * seconds, a worktree removal 10 minutes): a very slow pass is stopped too. That is safe, as
 * every step goes on from the ledger on the next pass, and a claim cut short before its run
 * file is written goes stuck, as it cannot be confirmed.
 */
export const PASS_TIMEOUT = Duration.minutes(30);

/** Runs `onePass` on the loop's schedule in a fiber of the scope. The first pass starts at once. */
export const runLoop = (
  onePass: Effect.Effect<Report>,
  pollSeconds: number,
): Effect.Effect<Loop, never, Scope.Scope> =>
  Effect.gen(function* () {
    const latch = yield* Latch.make(false);
    const next = { done: yield* Deferred.make<Report | null>() };
    const loop = Effect.gen(function* () {
      for (;;) {
        yield* latch.close;
        const report = yield* onePass.pipe(
          Effect.timeoutOption(PASS_TIMEOUT),
          Effect.flatMap((done) =>
            done._tag === "Some"
              ? Effect.succeed(done.value)
              : Effect.logError("factory pass timed out and was stopped").pipe(Effect.as(null)),
          ),
          Effect.catchCause((cause) =>
            Effect.logError("factory pass failed", cause).pipe(Effect.as(null)),
          ),
        );
        const finished = next.done;
        next.done = yield* Deferred.make<Report | null>();
        yield* Deferred.succeed(finished, report);
        yield* Effect.raceFirst(Effect.sleep(Duration.seconds(pollSeconds)), latch.await);
      }
    });
    yield* Effect.forkScoped(loop, { startImmediately: true });
    return {
      wake: Effect.asVoid(latch.open),
      awaitPass: Effect.suspend(() => Deferred.await(next.done)),
    };
  });
