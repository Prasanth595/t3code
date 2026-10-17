import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

export const AdmissionStatus = Schema.Struct({
  draining: Schema.Boolean,
  running: Schema.Int,
  queued: Schema.Int,
});

export class AdmissionDrainingError extends Schema.TaggedError<AdmissionDrainingError>()(
  "AdmissionDrainingError",
  { retryable: Schema.Literal(true) },
) {
  override get message(): string {
    return "ADMISSION_DRAINING: admission is paused for restart; retry the same command ID after resume.";
  }
}

export class AdmissionStorageError extends Schema.TaggedError<AdmissionStorageError>()(
  "AdmissionStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Admission state could not be read or persisted.";
  }
}

const isAdmissionStorageError = Schema.is(AdmissionStorageError);

export class Admission extends Context.Service<
  Admission,
  {
    /** Drain and command/queue promotion share this fence. Always acquire it before thread locks. */
    readonly withFence: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly isDraining: Effect.Effect<boolean, AdmissionStorageError>;
    readonly preserveQueuedOnRestart: (
      trigger: "startup" | "shutdown",
    ) => Effect.Effect<boolean, AdmissionStorageError>;
    readonly ensureOpen: Effect.Effect<void, AdmissionDrainingError | AdmissionStorageError>;
    readonly drain: Effect.Effect<typeof AdmissionStatus.Type, AdmissionStorageError>;
    readonly status: Effect.Effect<typeof AdmissionStatus.Type, AdmissionStorageError>;
    readonly resume: Effect.Effect<typeof AdmissionStatus.Type, AdmissionStorageError>;
  }
>()("t3/orchestration-v2/Admission") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fence = yield* Semaphore.make(1);
  // Local operational state is separate from the event-sourced conversation.
  // A new server opens admission; durable queued runs/messages are never rewritten.
  yield* sql`CREATE TABLE IF NOT EXISTS orchestration_v2_admission (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    draining INTEGER NOT NULL CHECK (draining IN (0, 1))
  )`;
  yield* sql`INSERT INTO orchestration_v2_admission (singleton, draining) VALUES (1, 0)
    ON CONFLICT(singleton) DO NOTHING`;

  const isDraining = sql<{ draining: number }>`
    SELECT draining FROM orchestration_v2_admission WHERE singleton = 1
  `.pipe(
    Effect.map((rows) => rows[0]!.draining === 1),
    Effect.mapError((cause) => new AdmissionStorageError({ cause })),
  );
  const readStatus = Effect.gen(function* () {
    // Starting/preparing runs include admitted work that has not reached the provider yet.
    // Provider background items can outlive a completed run; they also prevent safe restart.
    const rows = yield* sql<{ draining: number; running: number; queued: number }>`
      SELECT draining,
        (SELECT COUNT(*) FROM (
          SELECT run_id AS id FROM orchestration_v2_projection_runs
          WHERE status IN ('preparing', 'starting', 'running', 'waiting')
          UNION
          SELECT COALESCE(run_id, turn_item_id) AS id FROM orchestration_v2_projection_turn_items
          WHERE status IN ('pending', 'running', 'waiting')
            AND type IN ('command_execution', 'dynamic_tool', 'subagent')
            AND NOT (type = 'subagent' AND COALESCE(json_extract(payload_json, '$.origin'), '') = 'app_owned')
        )) AS running,
        (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE status = 'queued') AS queued
      FROM orchestration_v2_admission WHERE singleton = 1
    `;
    const row = rows[0]!;
    return { draining: row.draining === 1, running: row.running, queued: row.queued };
  }).pipe(Effect.mapError((cause) => new AdmissionStorageError({ cause })));
  const previous = yield* readStatus;
  const startupDrained = previous.draining && previous.running === 0;
  yield* sql`UPDATE orchestration_v2_admission SET draining = 0 WHERE singleton = 1`;
  const withFence = fence.withPermits(1);
  const setDraining = (draining: boolean) =>
    withFence(
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE orchestration_v2_admission SET draining = ${draining ? 1 : 0}
            WHERE singleton = 1`;
            return yield* readStatus;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isAdmissionStorageError(cause) ? cause : new AdmissionStorageError({ cause }),
          ),
        ),
    );

  return Admission.of({
    withFence,
    isDraining,
    preserveQueuedOnRestart: (trigger) =>
      Effect.gen(function* () {
        const current = yield* readStatus;
        return (
          current.running === 0 && (current.draining || (trigger === "startup" && startupDrained))
        );
      }),
    ensureOpen: Effect.gen(function* () {
      if (yield* isDraining) return yield* new AdmissionDrainingError({ retryable: true });
    }),
    drain: setDraining(true),
    status: withFence(readStatus),
    resume: setDraining(false),
  });
});

export const layer = Layer.effect(Admission, make.pipe(Effect.orDie));
