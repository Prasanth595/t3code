import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { RelayClientTracer, withRelayClientTracing } from "@t3tools/shared/relayTracing";

it.effect("logs relay spans while preserving their exporter and attributes", () =>
  Effect.gen(function* () {
    vi.stubGlobal("__DEV__", true);
    vi.stubEnv("EXPO_PUBLIC_T3CODE_LOG_SPANS", "1");
    using log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exported: Array<string> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (time, exit) => {
          end(time, exit);
          exported.push(span.name);
        };
        return span;
      },
    });
    try {
      const DevSpanLog = yield* Effect.promise(() => import("./devSpanLog"));
      yield* Effect.gen(function* () {
        const span = yield* Effect.makeSpan("relay.test", { attributes: { route: "relay" } });
        span.end(span.status.startTime + 2_000_000n, Exit.succeed(undefined));
      }).pipe(
        withRelayClientTracing,
        Effect.provide(
          DevSpanLog.layer.pipe(
            Layer.provideMerge(Layer.succeed(RelayClientTracer, Option.some(tracer))),
          ),
        ),
      );
      expect(exported).toEqual(["relay.test"]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"name":"relay.test"'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"attributes":{"route":"relay"}'));
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  }),
);
