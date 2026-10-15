import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const layerTest = TurnItemPositionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect("reuses an item's position without attempting another allocation insert", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const input = {
      threadId: ThreadId.make("thread:position-reuse"),
      turnItemId: TurnItemId.make("item:streaming"),
      runId: null,
    };
    const first = yield* positions.allocate(input);
    assert.equal(first, 1);

    // BEFORE INSERT runs even when ON CONFLICT would discard the allocation.
    yield* sql`
      CREATE TEMP TRIGGER reject_redundant_position_insert
      BEFORE INSERT ON orchestration_v2_turn_item_positions
      WHEN EXISTS (
        SELECT 1 FROM orchestration_v2_turn_item_positions
        WHERE thread_id = NEW.thread_id AND turn_item_id = NEW.turn_item_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Existing item positions must be reused');
      END
    `;

    const next = yield* positions.allocate({
      ...input,
      turnItemId: TurnItemId.make("item:next"),
    });
    assert.equal(next, first + 1);
    assert.equal(yield* positions.allocate(input), first);
    assert.equal(
      yield* positions.allocate({
        ...input,
        runId: RunId.make("run:moved"),
        runOrdinal: 2,
      }),
      first,
    );
    assert.equal(
      yield* positions.allocate({ ...input, threadId: ThreadId.make("thread:other") }),
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("places a held queued run that resumes after a restart continuation below it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("thread:held-queue");
    const allocate = (runOrdinal: number, item: string) =>
      positions.allocate({
        threadId,
        turnItemId: TurnItemId.make(item),
        runId: RunId.make(`run:${runOrdinal}`),
        runOrdinal,
      });

    const cut = yield* allocate(18, "item:cut");
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
      )
      VALUES ('item:cut', ${threadId}, 'run:18', ${cut}, 'assistant_message', 'completed', '', '{}')
    `;
    const continuation = yield* allocate(21, "item:continuation");
    // The resumed run's items are normalized before the projection stores any of them.
    const resumedUser = yield* allocate(19, "item:resumed-user");
    const resumedAnswer = yield* allocate(19, "item:resumed-answer");
    const lateCut = yield* allocate(18, "item:cut-late");

    assert.isTrue(continuation < resumedUser && resumedUser < resumedAnswer);
    assert.isTrue(cut < lateCut && lateCut < continuation);
  }).pipe(Effect.provide(layerTest)),
);
