import { OrchestrationV2TurnItem, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class TurnItemPositionStoreError extends Schema.TaggedError<TurnItemPositionStoreError>()(
  "TurnItemPositionStoreError",
  {
    threadId: ThreadId,
    turnItemId: TurnItemId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isTurnItemPositionStoreError = Schema.is(TurnItemPositionStoreError);

const POSITIONS_PER_RUN = 1_000_000;

export interface TurnItemPositionStoreV2Shape {
  readonly allocate: (input: {
    readonly threadId: ThreadId;
    readonly turnItemId: TurnItemId;
    readonly runId: RunId | null;
    readonly runOrdinal?: number;
  }) => Effect.Effect<number, TurnItemPositionStoreError>;
  readonly normalize: (
    item: OrchestrationV2TurnItem,
    runOrdinal?: number,
  ) => Effect.Effect<OrchestrationV2TurnItem, TurnItemPositionStoreError>;
}

export class TurnItemPositionStoreV2 extends Context.Service<
  TurnItemPositionStoreV2,
  TurnItemPositionStoreV2Shape
>()("t3/orchestration-v2/TurnItemPositionStore/TurnItemPositionStoreV2") {}

export const layer: Layer.Layer<TurnItemPositionStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  TurnItemPositionStoreV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    /**
     * A run's items go in the bucket of its ordinal. A queued run can start
     * after a later run, such as a restart continuation. Its items then go in
     * the newest bucket, so they show below what already ran. Runs that share
     * a bucket stay in start order because each item takes the next position.
     */
    const runBucket = (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly runOrdinal: number;
    }) =>
      Effect.gen(function* () {
        const newest = yield* sql<{ readonly ordinal: number | null }>`
          SELECT MAX(ordinal) AS ordinal
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${input.threadId}
        `;
        const newestBucket = Math.floor((newest[0]?.ordinal ?? 0) / POSITIONS_PER_RUN);
        if (newestBucket <= input.runOrdinal) return input.runOrdinal;
        // A run that already shows items keeps their bucket for its late items.
        const shown = yield* sql<{ readonly ordinal: number | null }>`
          SELECT MAX(ordinal) AS ordinal
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${input.threadId} AND run_id = ${input.runId}
        `;
        const shownOrdinal = shown[0]?.ordinal ?? null;
        return shownOrdinal === null ? newestBucket : Math.floor(shownOrdinal / POSITIONS_PER_RUN);
      });

    const allocate: TurnItemPositionStoreV2Shape["allocate"] = ({
      threadId,
      turnItemId,
      runId,
      runOrdinal: suppliedRunOrdinal,
    }) =>
      Effect.gen(function* () {
        const existing = yield* sql<{ readonly ordinal: number }>`
          SELECT ordinal
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
          LIMIT 1
        `;
        if (existing[0] !== undefined) return existing[0].ordinal;

        const runRows =
          runId === null
            ? []
            : yield* sql<{ readonly ordinal: number }>`
                SELECT ordinal
                FROM orchestration_v2_projection_runs
                WHERE thread_id = ${threadId} AND run_id = ${runId}
                LIMIT 1
              `;
        const runOrdinal = suppliedRunOrdinal ?? runRows[0]?.ordinal ?? null;
        const bucket =
          runId === null || runOrdinal === null
            ? 0
            : yield* runBucket({ threadId, runId, runOrdinal });
        const lowerBound = bucket * POSITIONS_PER_RUN;
        const upperBound = lowerBound + POSITIONS_PER_RUN - 1;
        yield* sql`
          INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
          SELECT
            ${threadId},
            ${turnItemId},
            COALESCE(MAX(ordinal), ${lowerBound}) + 1
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId}
            AND ordinal >= ${lowerBound}
            AND ordinal <= ${upperBound}
          ON CONFLICT(thread_id, turn_item_id) DO NOTHING
        `;
        const rows = yield* sql<{ readonly ordinal: number }>`
          SELECT ordinal
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
          LIMIT 1
        `;
        const ordinal = rows[0]?.ordinal;
        if (ordinal === undefined) {
          return yield* new TurnItemPositionStoreError({
            threadId,
            turnItemId,
            cause: "Position allocation returned no row.",
          });
        }
        return ordinal;
      }).pipe(
        Effect.mapError((cause) =>
          isTurnItemPositionStoreError(cause)
            ? cause
            : new TurnItemPositionStoreError({ threadId, turnItemId, cause }),
        ),
      );

    return TurnItemPositionStoreV2.of({
      allocate,
      normalize: (item, runOrdinal) =>
        allocate({
          threadId: item.threadId,
          turnItemId: item.id,
          runId: item.runId,
          ...(runOrdinal === undefined ? {} : { runOrdinal }),
        }).pipe(Effect.map((ordinal) => (item.ordinal === ordinal ? item : { ...item, ordinal }))),
    });
  }),
);
