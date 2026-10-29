import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

interface RefreshState<A> {
  readonly value: Option.Option<A>;
  readonly computedAtNanos: bigint;
  readonly pending: Deferred.Deferred<A> | undefined;
}

/**
 * Serves the last computed value at once and recomputes it in the background once it is older
 * than `maxAge`. Only reads before the first compute finishes wait; `warm` starts that compute
 * now. Server config is on every client's connect path, so slow host probes must not run inside it.
 */
export const makeBackgroundRefreshed = Effect.fnUntraced(function* <A>(
  compute: Effect.Effect<A>,
  maxAge: Duration.Input,
  options?: { readonly warm?: boolean },
) {
  const scope = yield* Effect.scope;
  const maxAgeNanos = Duration.toNanosUnsafe(maxAge);
  const state = yield* Ref.make<RefreshState<A>>({
    value: Option.none(),
    computedAtNanos: 0n,
    pending: undefined,
  });

  const startRefresh = Effect.gen(function* () {
    const pending = yield* Deferred.make<A>();
    const selected = yield* Ref.modify(state, (current) =>
      current.pending === undefined
        ? ([pending, { ...current, pending }] as const)
        : ([current.pending, current] as const),
    );
    if (selected === pending) {
      yield* compute.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (Exit.isSuccess(exit)) {
              const computedAtNanos = yield* Clock.monotonicTimeNanos;
              yield* Ref.set(state, {
                value: Option.some(exit.value),
                computedAtNanos,
                pending: undefined,
              });
            } else {
              yield* Ref.update(state, (current) => ({ ...current, pending: undefined }));
            }
            yield* Deferred.done(pending, exit);
          }),
        ),
        Effect.exit,
        Effect.interruptible,
        Effect.forkIn(scope),
      );
    }
    return selected;
  }).pipe(Effect.uninterruptible);

  if (options?.warm === true) yield* startRefresh;

  return Effect.gen(function* () {
    const current = yield* Ref.get(state);
    if (Option.isNone(current.value)) {
      return yield* Deferred.await(yield* startRefresh);
    }
    const now = yield* Clock.monotonicTimeNanos;
    if (now - current.computedAtNanos >= maxAgeNanos) {
      yield* startRefresh;
    }
    return current.value.value;
  });
});
