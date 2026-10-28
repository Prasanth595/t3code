import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import type { TraceRecord, TraceSink } from "@t3tools/shared/observability";
import * as Diagnostics from "./TemporaryThreadDiagnostics.ts";
import * as Effect from "effect/Effect";

import * as BrowserTraceCollector from "./BrowserTraceCollector.ts";

it.effect("temporary browser trace payloads never reach the sink", () => {
  const records: TraceRecord[] = [];
  const sink: TraceSink = {
    filePath: "/unused",
    push: (record) => records.push(record),
    flush: Effect.void,
    close: () => Effect.void,
  };
  return Effect.gen(function* () {
    const diagnostics = yield* Diagnostics.TemporaryThreadDiagnostics;
    diagnostics.enter(ThreadId.make("private-trace"));
    const collector = BrowserTraceCollector.make(sink);
    yield* collector.record([
      {
        type: "effect-span",
        name: "temporary-sentinel",
        kind: "internal",
        traceId: "private-trace",
        spanId: "private-span",
        sampled: true,
        startTimeUnixNano: "0",
        endTimeUnixNano: "1",
        durationMs: 0,
        attributes: { text: "temporary-sentinel" },
        events: [],
        links: [],
        exit: { _tag: "Success" },
      },
    ]);
    assert.deepEqual(records, []);
  }).pipe(Effect.provide(Diagnostics.layer));
});
