import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import { backfillStoredSnapshots } from "./EventSnapshotRetirement.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerStores = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  EventStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
);
const layerTest = () =>
  Layer.fresh(
    Layer.mergeAll(
      layerStores,
      EventSink.layer.pipe(Layer.provide(layerStores)),
      ProjectionMaintenance.layer.pipe(Layer.provide(layerStores)),
    ),
  );

const providerInstanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("thread:snapshots");
const now = DateTime.makeUnsafe("2026-10-14T00:00:00Z");

const thread: OrchestrationV2AppThread = {
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId: ProjectId.make("project:snapshots"),
  title: "Snapshots",
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};

const created: OrchestrationV2DomainEvent = {
  id: EventId.make("create"),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: now,
  payload: thread,
};

const node = (id: string, nodeId: string, status: "running" | "completed") =>
  ({
    id: EventId.make(id),
    type: "node.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: NodeId.make(nodeId),
      threadId,
      runId: null,
      parentNodeId: null,
      rootNodeId: NodeId.make(nodeId),
      kind: "reasoning",
      status,
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
    },
  }) satisfies OrchestrationV2DomainEvent;

const message = (id: string, text: string) =>
  ({
    id: EventId.make(id),
    type: "message.updated",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "agent",
      creationSource: "provider",
      id: MessageId.make("message"),
      threadId,
      runId: null,
      nodeId: null,
      role: "assistant",
      text,
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  }) satisfies OrchestrationV2DomainEvent;

const itemBase = {
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  title: null,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
} as const;

const reasoning = (id: string, text: string) =>
  ({
    id: EventId.make(id),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload: {
      ...itemBase,
      id: TurnItemId.make("reasoning"),
      status: "running",
      type: "reasoning",
      text,
      streaming: true,
    },
  }) satisfies OrchestrationV2DomainEvent;

const subagent = (id: string, title: string) =>
  ({
    id: EventId.make(id),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload: {
      ...itemBase,
      id: TurnItemId.make("subagent"),
      ordinal: 2,
      status: "running",
      title,
      type: "subagent",
      subagentId: NodeId.make("subagent-node"),
      origin: "provider_native",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId,
      childThreadId: ThreadId.make("thread:child"),
      prompt: "Review the change",
      result: null,
    },
  }) satisfies OrchestrationV2DomainEvent;

const storedEventIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly event_id: string }>`
    SELECT event_id FROM orchestration_events
    WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
    ORDER BY sequence ASC
  `;
  return rows.map((row) => row.event_id);
});

/** Rebuilding from the remaining events reproduces the live projection. */
const assertRebuildMatches = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
  const live = yield* projections.getThreadProjection(threadId);
  assert.isTrue((yield* maintenance.rebuild).valid);
  assert.deepEqual(yield* projections.getThreadProjection(threadId), live);
});

it.effect("keeps only the first and latest snapshot of each entity", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const write = (...events: Array<OrchestrationV2DomainEvent>) => sink.write({ events });
    yield* write(created);
    yield* write(node("n1", "node", "running"), reasoning("r1", "A"));
    yield* write(node("n2", "node", "running"), reasoning("r2", "A b"));
    yield* write(node("n3", "node", "running"), node("n4", "node", "completed"));
    yield* write(reasoning("r3", "A b c"), message("m1", "one"), message("m2", "two"));
    yield* write(subagent("s1", "one"), subagent("s2", "two"), subagent("s3", "three"));
    // A retried command reads its own events back, so they stay.
    const commandId = CommandId.make("command:snapshots");
    yield* sink.write({ commandId, events: [node("c1", "commanded", "running")] });
    yield* sink.write({ commandId, events: [node("c2", "commanded", "completed")] });

    assert.deepEqual(yield* storedEventIds, [
      "create",
      "n1",
      "r1",
      "n4",
      "r3",
      "m1",
      "m2",
      "s1",
      "s2",
      "s3",
      "c1",
      "c2",
    ]);
    yield* assertRebuildMatches;
  }).pipe(Effect.provide(layerTest())),
);

it.effect("retires snapshots stored before the migration and joins later writes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* EventStore.EventStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;

    // An older build stored every snapshot.
    const stored = yield* eventStore.append({
      events: [
        created,
        node("n1", "node", "running"),
        node("n2", "node", "running"),
        node("n3", "node", "running"),
        reasoning("r1", "A"),
        reasoning("r2", "A b"),
        node("o1", "other", "running"),
        node("o2", "other", "running"),
        node("o3", "other", "completed"),
        subagent("s1", "one"),
        subagent("s2", "two"),
        subagent("s3", "three"),
      ],
    });
    yield* Effect.forEach(stored, (event) => projections.apply(event.event), { discard: true });
    yield* sql`
      INSERT INTO orchestration_v2_event_snapshot_backfill (id, through_sequence, after_thread_id)
      VALUES (1, ${stored.at(-1)!.sequence}, '')
    `;
    // The upgraded server stores more snapshots before the backfill reaches the thread.
    yield* sink.write({ events: [node("n4", "node", "running")] });
    yield* sink.write({ events: [node("n5", "node", "running")] });

    yield* backfillStoredSnapshots({ pause: () => Effect.void });

    assert.deepEqual(yield* storedEventIds, [
      "create",
      "n1",
      "r1",
      "r2",
      "o1",
      "o3",
      "s1",
      "s2",
      "s3",
      "n5",
    ]);
    const remaining = yield* sql`SELECT 1 FROM orchestration_v2_event_snapshot_backfill`;
    assert.lengthOf(remaining, 0);

    // The node's head now starts at its oldest snapshot.
    yield* sink.write({ events: [node("n6", "node", "completed")] });
    assert.deepEqual(
      (yield* storedEventIds).filter((id) => id.startsWith("n")),
      ["n1", "n6"],
    );
    // Running it again finds nothing left to do.
    yield* backfillStoredSnapshots({ pause: () => Effect.void });
    yield* assertRebuildMatches;
  }).pipe(Effect.provide(layerTest())),
);
