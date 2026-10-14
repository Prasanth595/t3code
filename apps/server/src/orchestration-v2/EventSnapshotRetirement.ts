import type { OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";

/**
 * Node, message and turn-item events each store the entity's full state, and
 * providers update them with every streamed delta. Only two snapshots per
 * entity matter. The latest is its state. The first keeps the entity where it
 * first appeared in a replayed range: a client drops an unknown turn item that
 * arrives after a later one, taking it for history it never loaded. Every
 * snapshot between them is deleted once a newer one is stored.
 *
 * Only snapshots without a command are retired, because a retried command
 * reads its own events back. Subagent items are kept whole: later rows point
 * at the row that stores the subagent's prompt.
 */
const SNAPSHOT_EVENT_TYPES = ["node.updated", "message.updated", "turn-item.updated"] as const;

/** The entity a retirable snapshot describes, or null when the event must be kept. */
const retirableEntityId = (stored: OrchestrationV2StoredEvent): string | null => {
  if (stored.commandId !== null) return null;
  switch (stored.event.type) {
    case "node.updated":
    case "message.updated":
      return stored.event.payload.id;
    case "turn-item.updated":
      return stored.event.payload.type === "subagent" ? null : stored.event.payload.id;
    default:
      return null;
  }
};

interface Head {
  readonly first_sequence: number;
  readonly last_sequence: number;
}

/**
 * Runs inside the sink's write transaction, after the events are stored, so a
 * superseded snapshot and its replacement commit together.
 */
export const retireSupersededSnapshots = Effect.fn("retireSupersededSnapshots")(function* (
  storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const stored of storedEvents) {
    const entityId = retirableEntityId(stored);
    if (entityId === null) continue;
    const eventType = stored.event.type;
    const heads = yield* sql<Head>`
      SELECT first_sequence, last_sequence FROM orchestration_v2_event_snapshot_heads
      WHERE event_type = ${eventType} AND entity_id = ${entityId}
    `;
    const head = heads[0];
    if (head === undefined) {
      yield* sql`
        INSERT INTO orchestration_v2_event_snapshot_heads
          (event_type, entity_id, first_sequence, last_sequence)
        VALUES (${eventType}, ${entityId}, ${stored.sequence}, ${stored.sequence})
      `;
      continue;
    }
    if (head.last_sequence !== head.first_sequence) {
      yield* sql`DELETE FROM orchestration_events WHERE sequence = ${head.last_sequence}`;
    }
    yield* sql`
      UPDATE orchestration_v2_event_snapshot_heads SET last_sequence = ${stored.sequence}
      WHERE event_type = ${eventType} AND entity_id = ${entityId}
    `;
  }
});

interface SnapshotRow {
  readonly sequence: number;
  readonly event_type: string;
  readonly entity_id: string | null;
  readonly bytes: number;
}

interface EntitySnapshots {
  readonly eventType: string;
  readonly entityId: string;
  readonly first: number;
  last: number;
  lastBytes: number;
}

interface StoredSnapshot {
  readonly sequence: number;
  readonly bytes: number;
}

// The scan runs on the reader worker. Deletes hold the writer, so each batch
// is sized to take about this long and is followed by a longer pause.
const TARGET_BATCH_MS = 25;
const PAUSE_PER_BATCH = 4;
// Deleting a row frees every overflow page of its payload, so a few large
// snapshots cost more than many small ones.
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const SCAN_PAGE_SIZE = 1000;

export interface BackfillOptions {
  /** Waits after a delete batch that took `elapsedMs`. Defaults to four times as long. */
  readonly pause?: (elapsedMs: number) => Effect.Effect<void>;
}

const defaultPause = (elapsedMs: number) =>
  Effect.sleep(Duration.millis(Math.max(10, elapsedMs * PAUSE_PER_BATCH)));

interface Pacing {
  readonly pause: (elapsedMs: number) => Effect.Effect<void>;
  batchSize: number;
}

/** Runs `run` over `items` in write transactions sized to TARGET_BATCH_MS. */
const inPacedBatches = <A, E, R>(
  pacing: Pacing,
  items: ReadonlyArray<A>,
  run: (batch: ReadonlyArray<A>) => Effect.Effect<void, E, R>,
  bytesOf: (item: A) => number = () => 0,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    let index = 0;
    while (index < items.length) {
      let end = index + 1;
      let bytes = bytesOf(items[index]!);
      while (
        end < items.length &&
        end - index < pacing.batchSize &&
        bytes + bytesOf(items[end]!) <= MAX_BATCH_BYTES
      ) {
        bytes += bytesOf(items[end]!);
        end += 1;
      }
      const batch = items.slice(index, end);
      index = end;
      const started = yield* Clock.currentTimeMillis;
      yield* sql.withTransaction(run(batch));
      const elapsed = (yield* Clock.currentTimeMillis) - started;
      pacing.batchSize = Math.min(
        4096,
        Math.max(16, Math.round((pacing.batchSize * TARGET_BATCH_MS) / Math.max(1, elapsed))),
      );
      yield* pacing.pause(elapsed);
    }
  });

/**
 * Retires the snapshots one thread stored up to `throughSequence`, including
 * across heads that writes since the migration started. Each page's
 * superseded rows are deleted right after it is read, while the pages a
 * delete has to walk are still cached. Deleting a deleted row is a no-op, so
 * an interrupted thread is simply scanned again.
 */
const backfillThread = Effect.fn("backfillThreadSnapshots")(function* (
  threadId: string,
  throughSequence: number,
  pacing: Pacing,
) {
  const sql = yield* SqlClient.SqlClient;
  const entities = new Map<string, EntitySnapshots>();
  const middle: Array<StoredSnapshot> = [];
  let afterSequence = 0;
  while (true) {
    const page = yield* sql
      .withTransaction(
        sql<SnapshotRow>`
          SELECT
            sequence,
            event_type,
            json_extract(payload_json, '$.id') AS entity_id,
            octet_length(payload_json) AS bytes
          -- Statistics cannot say most rows have no command, so the planner
          -- otherwise walks every commandless event: minutes per page.
          FROM orchestration_events INDEXED BY idx_orchestration_events_agent_stream_sequence
          WHERE application_event_version = 2
            AND aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND sequence > ${afterSequence}
            AND sequence <= ${throughSequence}
            AND event_type IN ${sql.in(SNAPSHOT_EVENT_TYPES)}
            AND command_id IS NULL
            AND NOT (
              event_type = 'turn-item.updated'
              AND json_extract(payload_json, '$.type') = 'subagent'
            )
          ORDER BY sequence ASC
          LIMIT ${SCAN_PAGE_SIZE}
        `,
      )
      .pipe(NodeSqliteClient.readOnly);
    for (const row of page) {
      if (row.entity_id === null) continue;
      const key = `${row.event_type}\u0000${row.entity_id}`;
      const entity = entities.get(key);
      if (entity === undefined) {
        entities.set(key, {
          eventType: row.event_type,
          entityId: row.entity_id,
          first: row.sequence,
          last: row.sequence,
          lastBytes: row.bytes,
        });
        continue;
      }
      if (entity.last !== entity.first) {
        middle.push({ sequence: entity.last, bytes: entity.lastBytes });
      }
      entity.last = row.sequence;
      entity.lastBytes = row.bytes;
    }
    yield* inPacedBatches(
      pacing,
      middle.splice(0),
      (batch) =>
        sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(
          batch.map((snapshot) => snapshot.sequence),
        )}`,
      (snapshot) => snapshot.bytes,
    );
    if (page.length < SCAN_PAGE_SIZE) break;
    afterSequence = page.at(-1)!.sequence;
  }

  // A join can delete the old latest snapshot and the first new one, which
  // is usually about as large.
  yield* inPacedBatches(
    pacing,
    [...entities.values()],
    (batch) => Effect.forEach(batch, joinHead, { discard: true }),
    (entity) => entity.lastBytes * 2,
  );
});

/**
 * A write since the migration may already track the entity, from its first
 * new snapshot. The head moves back to the old first snapshot, and the rows
 * between that and the latest one go. Entities nothing has written since need
 * no head: one updated again keeps an extra snapshot or two.
 */
const joinHead = Effect.fn("joinSnapshotHead")(function* (entity: EntitySnapshots) {
  const sql = yield* SqlClient.SqlClient;
  const heads = yield* sql<Head>`
    SELECT first_sequence, last_sequence FROM orchestration_v2_event_snapshot_heads
    WHERE event_type = ${entity.eventType} AND entity_id = ${entity.entityId}
  `;
  const head = heads[0];
  if (head === undefined || head.first_sequence <= entity.last) return;
  const retired = [
    ...(entity.last === entity.first ? [] : [entity.last]),
    ...(head.first_sequence === head.last_sequence ? [] : [head.first_sequence]),
  ];
  if (retired.length > 0) {
    yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(retired)}`;
  }
  yield* sql`
    UPDATE orchestration_v2_event_snapshot_heads SET first_sequence = ${entity.first}
    WHERE event_type = ${entity.eventType} AND entity_id = ${entity.entityId}
  `;
});

/**
 * Retires the snapshots stored before migration 063, a thread at a time, and
 * records each finished thread so a restart resumes after it. Runs in the
 * background once the server is ready, and is a no-op once done.
 */
export const backfillStoredSnapshots = Effect.fn("backfillStoredSnapshots")(function* (
  options?: BackfillOptions,
) {
  const sql = yield* SqlClient.SqlClient;
  const pacing: Pacing = { pause: options?.pause ?? defaultPause, batchSize: 16 };
  while (true) {
    const state = yield* sql<{
      readonly through_sequence: number;
      readonly after_thread_id: string;
    }>`
      SELECT through_sequence, after_thread_id FROM orchestration_v2_event_snapshot_backfill
      WHERE id = 1
    `;
    const current = state[0];
    if (current === undefined) return;
    const next = yield* sql<{ readonly thread_id: string | null }>`
      SELECT MIN(stream_id) AS thread_id FROM orchestration_events
      WHERE application_event_version = 2
        AND aggregate_kind = 'thread'
        AND stream_id > ${current.after_thread_id}
    `;
    const threadId = next[0]?.thread_id ?? null;
    if (threadId === null) {
      yield* sql`DELETE FROM orchestration_v2_event_snapshot_backfill WHERE id = 1`;
      return;
    }
    yield* backfillThread(threadId, current.through_sequence, pacing);
    yield* sql`
      UPDATE orchestration_v2_event_snapshot_backfill SET after_thread_id = ${threadId}
      WHERE id = 1
    `;
  }
});

/** Retires the snapshots stored before migration 063 once the server is active. */
export const layerBackfillWorker = Layer.effectDiscard(
  forkParked(
    backfillStoredSnapshots().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to retire stored event snapshots", {
          cause: Cause.pretty(cause),
        }),
      ),
    ),
  ),
);
