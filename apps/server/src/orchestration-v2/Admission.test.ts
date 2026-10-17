import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Admission from "./Admission.ts";

const layer = Admission.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect("drain cannot report idle while an earlier admission still owns the fence", () =>
  Effect.gen(function* () {
    const gate = yield* Admission.Admission;
    const sql = yield* SqlClient.SqlClient;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const admitting = yield* gate
      .withFence(
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES ('before-drain', 'thread', 1, 'codex', 'starting', '2026-10-17T00:00:00Z', '{}')`;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const drainStarted = yield* Deferred.make<void>();
    const draining = yield* Effect.gen(function* () {
      yield* Deferred.succeed(drainStarted, undefined);
      return yield* gate.drain;
    }).pipe(Effect.forkChild);
    yield* Deferred.await(drainStarted);
    yield* Effect.yieldNow;
    assert.isUndefined(draining.pollUnsafe());
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(admitting);
    assert.deepEqual(yield* Fiber.join(draining), { draining: true, running: 1, queued: 0 });
    assert.equal((yield* gate.ensureOpen.pipe(Effect.flip))._tag, "AdmissionDrainingError");
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed'`;
    assert.deepEqual(yield* gate.status, { draining: true, running: 0, queued: 0 });
    yield* gate.resume;
    yield* gate.ensureOpen;
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "counts provider background work after a run completes but not queued app-owned children",
  () =>
    Effect.gen(function* () {
      const gate = yield* Admission.Admission;
      const sql = yield* SqlClient.SqlClient;
      for (const [id, payload] of [
        ["native", "{}"],
        ["app-owned", '{"origin":"app_owned"}'],
      ] as const)
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
      VALUES (${id}, 'thread', 1, 'subagent', 'running', '2026-10-17T00:00:00Z', ${payload})`;
      assert.deepEqual(yield* gate.drain, { draining: true, running: 1, queued: 0 });
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET status = 'completed' WHERE turn_item_id = 'native'`;
      assert.deepEqual(yield* gate.status, { draining: true, running: 0, queued: 0 });
    }).pipe(Effect.provide(layer)),
);
