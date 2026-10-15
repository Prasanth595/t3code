import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

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
