import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export const SwarmInvocation = Context.Reference<
  | {
      readonly validate: Effect.Effect<boolean>;
      readonly withLease: <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ) => Effect.Effect<A, E | false, R>;
    }
  | undefined
>("t3/orchestration-v2/SwarmInvocation", { defaultValue: () => undefined });
