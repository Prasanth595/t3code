import type { TraceRecord, TraceSink } from "@t3tools/shared/observability";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as TemporaryThreadDiagnostics from "./TemporaryThreadDiagnostics.ts";

export class BrowserTraceCollector extends Context.Service<
  BrowserTraceCollector,
  {
    readonly record: (records: ReadonlyArray<TraceRecord>) => Effect.Effect<void>;
  }
>()("t3/observability/BrowserTraceCollector") {}

/** @public */
export const make = (sink: TraceSink): BrowserTraceCollector["Service"] =>
  BrowserTraceCollector.of({
    record: Effect.fn("BrowserTraceCollector.record")(function* (records) {
      const diagnostics = yield* Effect.serviceOption(
        TemporaryThreadDiagnostics.TemporaryThreadDiagnostics,
      );
      if (Option.isSome(diagnostics) && !diagnostics.value.canRecord()) return;
      for (const record of records) {
        sink.push(record);
      }
    }),
  });

export const layer = (sink: TraceSink) => Layer.succeed(BrowserTraceCollector, make(sink));
