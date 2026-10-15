/**
 * The pass loop: one pass when the factory starts and one every `poll_seconds` after, with a
 * wake that starts the next pass now. Passes never overlap: one fiber runs them one after the
 * other, and a wake that arrives during a pass makes the next pass follow it at once, however
 * many wakes arrived.
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
  /** The report of the next pass to finish; null when that pass died. */
  readonly awaitPass: Effect.Effect<Report | null>;
}

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
