import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import { describe, expect } from "vite-plus/test";

import { makeBackgroundRefreshed } from "./backgroundRefresh.ts";

describe("makeBackgroundRefreshed", () => {
  it.effect("shares the first compute and reuses it while fresh", () =>
    Effect.gen(function* () {
      const computes = yield* Ref.make(0);
      const read = yield* makeBackgroundRefreshed(
        Ref.updateAndGet(computes, (n) => n + 1),
        "30 seconds",
      );

      const results = yield* Effect.all([read, read, read], { concurrency: "unbounded" });
      yield* TestClock.adjust("29 seconds");
      const later = yield* read;

      expect(results).toEqual([1, 1, 1]);
      expect(later).toBe(1);
      expect(yield* Ref.get(computes)).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("answers a stale read at once and refreshes behind it", () =>
    Effect.gen(function* () {
      const computes = yield* Ref.make(0);
      const gate = yield* Deferred.make<void>();
      const read = yield* makeBackgroundRefreshed(
        Effect.gen(function* () {
          const n = yield* Ref.updateAndGet(computes, (count) => count + 1);
          if (n > 1) yield* Deferred.await(gate);
          return n;
        }),
        "30 seconds",
      );

      expect(yield* read).toBe(1);
      yield* TestClock.adjust("30 seconds");
      // The refresh is blocked on the gate, so these reads only pass if they skip waiting for it.
      expect(yield* read).toBe(1);
      expect(yield* read).toBe(1);

      yield* Deferred.succeed(gate, undefined);
      yield* TestClock.adjust("1 millis");
      expect(yield* read).toBe(2);
      expect(yield* Ref.get(computes)).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("releases first readers after a defect and lets later reads retry", () =>
    Effect.gen(function* () {
      const computes = yield* Ref.make(0);
      const read = yield* makeBackgroundRefreshed(
        Effect.gen(function* () {
          const attempt = yield* Ref.updateAndGet(computes, (n) => n + 1);
          if (attempt === 1) return yield* Effect.die("probe failed");
          return attempt;
        }),
        "30 seconds",
      );
      const reader = yield* Effect.forkChild(Effect.exit(read));
      yield* TestClock.adjust("1 millis");
      const result = reader.pollUnsafe();
      expect(result).toMatchObject({ _tag: "Success", value: { _tag: "Failure" } });
      expect(yield* read).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("warm computes before the first read", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const read = yield* makeBackgroundRefreshed(
        Deferred.succeed(started, undefined).pipe(Effect.as("targets")),
        "30 seconds",
        { warm: true },
      );

      yield* Deferred.await(started);
      yield* TestClock.adjust("1 millis");
      expect(yield* read).toBe("targets");
    }).pipe(Effect.scoped),
  );
});
