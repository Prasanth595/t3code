import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

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
 * Tells a prompt that is waiting to be re-sent that it must not be delivered
 * anymore.
 */
export interface AcpPromptBusyRetryGuard {
  /**
   * Whether the turn was cancelled while the prompt was waiting to be re-sent.
   * A cancelled prompt must never reach the agent after the fact.
   */
  readonly cancelled: Effect.Effect<boolean>;
}

/**
 * Identifies one dispatched prompt.
 */
export interface AcpPromptBusyRetryToken {
  readonly _tag: "AcpPromptBusyRetryToken";
  readonly generation: number;
}

/**
 * Tracks which dispatched prompts may still reach the agent.
 *
 * A prompt the agent rejected as busy waits before it is re-sent, and the agent
 * never accepted it, so `session/cancel` has nothing to stop. The gate
 * invalidates the token of every prompt that is still waiting when the turn is
 * cancelled, so a cancelled prompt is never delivered after the fact.
 */
export interface AcpPromptBusyRetryGate {
  /** Take a token for a prompt that is being dispatched right now. */
  readonly issue: Effect.Effect<AcpPromptBusyRetryToken>;
  /** Invalidate the token of every prompt that is still waiting. */
  readonly cancel: Effect.Effect<void>;
  /** Whether the prompt holding the token was cancelled before it was delivered. */
  readonly cancelled: (token: AcpPromptBusyRetryToken) => Effect.Effect<boolean>;
}

export const makeAcpPromptBusyRetryGate: Effect.Effect<AcpPromptBusyRetryGate> = Effect.gen(
  function* () {
    const generationRef = yield* Ref.make(0);
    return {
      issue: Ref.updateAndGet(generationRef, (generation) => generation + 1).pipe(
        Effect.map((generation): AcpPromptBusyRetryToken => ({
          _tag: "AcpPromptBusyRetryToken",
          generation,
        })),
      ),
      cancel: Ref.update(generationRef, (generation) => generation + 1),
      cancelled: (token) =>
        Ref.get(generationRef).pipe(Effect.map((generation) => generation !== token.generation)),
    };
  },
);

/**
 * Re-send a prompt the agent rejected because its session still owns an active
 * turn. The rejection is transient: the agent never accepted the prompt, and it
 * accepts the same prompt once the previous turn releases its lease, so the
 * turn survives instead of failing outright.
 *
 * The re-send is dropped when the guard reports that the turn was cancelled
 * while the prompt was waiting. The prompt then fails as an interruption, so
 * the caller reports a cancelled turn instead of a failed one.
 */
export function retryPromptOnBusy<A, E, R>(
  policy: AcpPromptBusyRetryPolicy | undefined,
  effect: Effect.Effect<A, E, R>,
  guard?: AcpPromptBusyRetryGuard,
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
          Effect.andThen(guard === undefined ? Effect.succeed(false) : guard.cancelled),
          Effect.flatMap((cancelled) =>
            cancelled ? Effect.failCause(Cause.interrupt()) : run(attempt + 1),
          ),
        );
      }),
    );
  return run(1);
}
