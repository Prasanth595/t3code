import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";
import { describe } from "vite-plus/test";

import { makeSpanRegistry, wrapTracer } from "../observability/spanRegistry.ts";

/**
 * The wrapper has to recognise the spans this server's SQL client really creates, not a name it
 * assumed: effect names them after the database, so only their kind and attributes identify them.
 */
describe("the span registry over a real SQL statement", () => {
  it.effect("records the statement as sql, with its query text", () =>
    Effect.gen(function* () {
      const registry = makeSpanRegistry();
      const tracer = wrapTracer(
        Tracer.make({ span: (options) => new Tracer.NativeSpan(options) }),
        registry,
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`SELECT 1 AS answer`;
      }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
        Effect.withTracer(tracer),
      );
      const sqlSpans = registry.active(0, 1e12, 10).filter((span) => span.kind === "sql");
      assert.strictEqual(sqlSpans.length, 1);
      assert.include(sqlSpans[0]?.query, "SELECT 1 AS answer");
    }),
  );
});
