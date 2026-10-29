import { RelayClientTracer } from "@t3tools/shared/relayTracing";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

// Simulators share the host clock, so these lines line up with the server's trace file.
const MIN_LOGGED_SPAN_NANOS = 1_000_000n;

function loggedTracer(delegate: Tracer.Tracer): Tracer.Tracer {
  return Tracer.make({
    ...delegate,
    span(options) {
      const span = delegate.span(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const startTime = span.status.startTime;
        if (endTime - startTime < MIN_LOGGED_SPAN_NANOS) return;
        console.log(
          `[t3-span] ${JSON.stringify({
            name: span.name,
            startMs: Number(startTime / 1_000_000n),
            endMs: Number(endTime / 1_000_000n),
            ok: exit._tag === "Success",
            attributes: Object.fromEntries(span.attributes),
          })}`,
        );
      };
      return span;
    },
  });
}

/** Dev builds started with `EXPO_PUBLIC_T3CODE_LOG_SPANS=1` print every span of 1 ms or more. */
export const layer =
  __DEV__ && process.env.EXPO_PUBLIC_T3CODE_LOG_SPANS === "1"
    ? Layer.effectContext(
        Effect.gen(function* () {
          const local = yield* Tracer.Tracer;
          const relay = yield* RelayClientTracer;
          return Context.make(Tracer.Tracer, loggedTracer(local)).pipe(
            Context.add(RelayClientTracer, Option.map(relay, loggedTracer)),
          );
        }),
      )
    : Layer.empty;
