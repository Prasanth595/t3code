import * as Effect from "effect/Effect";
import * as Statement from "effect/sql/Statement";
import * as Tracer from "effect/Tracer";

/**
 * Which connections ran the work of `effect`, read off the spans the SQL client annotates: a
 * transaction is annotated on the span open where it begins, its statements are not.
 */
export const connectionsOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const spans: Array<Tracer.Span> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    yield* effect.pipe(
      Effect.withTracer(tracer),
      Effect.provideService(Statement.SpanPropagationEnabled, true),
    );
    return new Set(spans.flatMap((span) => span.attributes.get("db.connection") ?? []));
  });
