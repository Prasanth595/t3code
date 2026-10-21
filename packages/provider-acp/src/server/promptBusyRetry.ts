import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/**
 * How to re-send a prompt that the agent rejected because its session still
 * owns an active turn.
 */
export interface AcpPromptBusyRetryPolicy {
  /** How many times the prompt may be sent in total. */
  readonly maxAttempts: number;
  /** Whether the failure is the transient "session is busy" rejection. */
  readonly isBusyFailure: (cause: Cause.Cause<unknown>) => boolean;
  /** How long to wait before the next attempt. */
  readonly delayMs: (attempt: number) => number;
}

/**
 * Re-send a prompt the agent rejected because its session still owns an active
 * turn. The rejection is transient: the agent never accepted the prompt, and it
 * accepts the same prompt once the previous turn releases its lease, so the
 * turn survives instead of failing outright.
 */
export function retryPromptOnBusy<A, E, R>(
  policy: AcpPromptBusyRetryPolicy | undefined,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  if (policy === undefined) return effect;
  const run = (attempt: number): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.catchCause((cause) => {
        // An interrupt is a user action and never a busy rejection.
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        if (attempt >= policy.maxAttempts || !policy.isBusyFailure(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.sleep(Duration.millis(policy.delayMs(attempt))).pipe(
          Effect.andThen(run(attempt + 1)),
        );
      }),
    );
  return run(1);
}
