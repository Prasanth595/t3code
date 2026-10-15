import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Events from "./events.ts";
import { latestRunStatusChanges, type RunUpdate } from "./events.ts";
import type { RunStatus } from "./sessions.ts";

const STARTED = "2026-10-15T01:00:00.000Z";

const update = (
  threadId: string,
  ordinal: number,
  status: RunStatus,
  startedAt: unknown = STARTED,
): RunUpdate => ({ threadId, id: `${threadId}-run-${ordinal}`, ordinal, status, startedAt });

/** A queued run cancelled before it ever started: T3 gives it no `startedAt`. */
const cancelledUnstarted = (threadId: string, ordinal: number): RunUpdate =>
  update(threadId, ordinal, "cancelled", null);

const emitted = (updates: ReadonlyArray<RunUpdate>) =>
  latestRunStatusChanges(Stream.fromIterable(updates)).pipe(
    Stream.runCollect,
    Effect.map((ids) => Array.from(ids)),
  );

describe("latestRunStatusChanges", () => {
  it.effect("emits a thread's id for its first run.updated", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* emitted([update("a", 1, "running")]), ["a"]);
    }),
  );

  it.effect("emits nothing when the same run repeats its status", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* emitted([update("a", 1, "running"), update("a", 1, "running")]),
        ["a"],
      );
    }),
  );

  it.effect("emits again when the same run has a new status", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* emitted([
          update("a", 1, "running"),
          update("a", 1, "running"),
          update("a", 1, "completed"),
        ]),
        ["a", "a"],
      );
    }),
  );

  it.effect("tracks threads apart", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* emitted([
          update("a", 1, "running"),
          update("b", 1, "running"),
          update("a", 1, "running"),
          update("b", 1, "completed"),
          update("a", 1, "completed"),
        ]),
        ["a", "b", "b", "a"],
      );
    }),
  );

  it.effect("keeps a queued run cancelled before it started from hiding the completion", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* emitted([
          update("a", 1, "running"),
          update("a", 2, "queued", null),
          cancelledUnstarted("a", 2),
          update("a", 1, "completed"),
        ]),
        // run 1 running, run 2 queued (now the latest), run 2 cancelled so run 1
        // is the latest again, then run 1 completed.
        ["a", "a", "a", "a"],
      );
    }),
  );

  it.effect("emits when a new run becomes the latest after a completed one", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* emitted([
          update("a", 1, "running"),
          update("a", 1, "completed"),
          update("a", 2, "queued", null),
        ]),
        ["a", "a", "a"],
      );
    }),
  );

  it.effect("emits nothing for an update to a run below the started latest run", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* emitted([
          update("a", 1, "running"),
          update("a", 2, "running"),
          update("a", 1, "completed"),
        ]),
        ["a", "a"],
      );
    }),
  );

  it.effect("holds no state across runs of the stream", () =>
    Effect.gen(function* () {
      const updates = [update("a", 1, "running")];
      assert.deepStrictEqual(yield* emitted(updates), ["a"]);
      assert.deepStrictEqual(yield* emitted(updates), ["a"]);
      const stream = latestRunStatusChanges(Stream.fromIterable(updates));
      const first = yield* Stream.runCollect(stream);
      const second = yield* Stream.runCollect(stream);
      assert.deepStrictEqual([Array.from(first), Array.from(second)], [["a"], ["a"]]);
    }),
  );
});

/** A stored event as the sink delivers it, with only the fields the stream reads. */
const stored = (
  sequence: number,
  type: string,
  threadId: string,
  payload: Partial<RunUpdate> = {},
): OrchestrationV2StoredEvent =>
  ({ sequence, commandId: null, event: { type, threadId, payload } }) as never;

describe("FactoryEvents.runStatusChanges", () => {
  it.effect(
    "reads a run's first status from run.created, live only, and ignores other events",
    () =>
      Effect.gen(function* () {
        const store = [
          // History: at or below the live position the stream starts from.
          stored(7, "run.created", "old", { id: "old-run-1", ordinal: 1, status: "starting" }),
          stored(8, "run.updated", "a", { id: "a-run-1", ordinal: 1, status: "completed" }),
          stored(9, "thread.archived", "c"),
          stored(10, "run.created", "a", {
            id: "a-run-2",
            ordinal: 2,
            status: "queued",
            startedAt: null,
          }),
          stored(11, "run.created", "b", {
            id: "b-run-1",
            ordinal: 1,
            status: "starting",
            startedAt: null,
          }),
        ];
        // Filters as T3's sink does.
        const sink = Layer.mock(EventSink.EventSinkV2)({
          latestSequence: () => Effect.succeed(7),
          stream: (input) =>
            Stream.fromIterable(
              store.filter(
                (event) =>
                  event.sequence > (input?.afterSequence ?? 0) &&
                  (input?.eventType === undefined || event.event.type === input.eventType),
              ),
            ),
        });
        const events = yield* Events.make.pipe(Effect.provide(sink));
        const ids = yield* Stream.runCollect(events.runStatusChanges);
        assert.deepStrictEqual(Array.from(ids), ["a", "a", "b"]);
      }),
  );
});
