import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../src/persistence/Sqlite.ts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";

// Run with the isolated worktree server stopped. The event sink records history
// and updates projections together; timestamps model an inactive thread.
const databasePath = process.argv[2];
if (!databasePath?.includes("/issue-24041/.t3/"))
  throw new Error("Expected isolated issue-24041 database");
const database = Sqlite.layerFromPath(databasePath);
const stores = Layer.mergeAll(
  database,
  EventStore.layer.pipe(Layer.provide(database)),
  ProjectionStore.layer.pipe(Layer.provide(database)),
);
const services = Layer.mergeAll(stores, EventSink.layer.pipe(Layer.provide(stores)));
await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    const [source] = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_threads LIMIT 1`;
    if (!source) throw new Error("Create a scratch project/thread first");
    const template = JSON.parse(source.payload_json);
    for (const [suffix, ageDays] of [
      ["old", 2],
      ["fresh", 0],
    ] as const) {
      const id = `evidence:auto-settle:${suffix}`;
      const existing =
        yield* sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${id}`;
      if (existing.length) continue;
      const at = DateTime.makeUnsafe(Date.now() - ageDays * 86400000);
      const event = Schema.decodeUnknownSync(OrchestrationV2DomainEvent)({
        id: EventId.make(`evidence:created:${suffix}`),
        type: "thread.created",
        threadId: id,
        providerInstanceId: template.providerInstanceId,
        occurredAt: at,
        payload: {
          ...template,
          id,
          title: `Settlement evidence ${suffix}`,
          createdAt: at,
          updatedAt: at,
          lastVisitedAt: null,
          settledAt: null,
          settledOverride: null,
          archivedAt: null,
          deletedAt: null,
          snoozedAt: null,
          snoozedUntil: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
        },
      });
      const events = yield* sink.write({ events: [event] });
      console.log(JSON.stringify({ id, at, events }));
    }
  }).pipe(Effect.provide(services), Effect.provide(NodeServices.layer)),
);
