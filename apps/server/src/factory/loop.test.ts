import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import { runLoop } from "./loop.ts";
import type { Report } from "./pass.ts";

const report = (n: number): Report => ({ runs: n, claimed: 0, errors: 0, attention: 0 });

/** A pass that counts its calls; the `n`th one waits on `gate` when given. */
const counting = (gate?: { readonly at: number; readonly on: Deferred.Deferred<void> }) => {
  const calls = { n: 0 };
  const onePass = Effect.gen(function* () {
    calls.n += 1;
    const n = calls.n;
    if (gate !== undefined && n === gate.at) yield* Deferred.await(gate.on);
    return report(n);
  });
  return { calls, onePass };
};

describe("the pass loop", () => {
  it.effect("runs a pass when it starts and every poll_seconds after", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, onePass } = counting();
        yield* runLoop(onePass, 60);
        assert.strictEqual(calls.n, 1);
        yield* TestClock.adjust("59 seconds");
        assert.strictEqual(calls.n, 1);
        yield* TestClock.adjust("1 second");
        assert.strictEqual(calls.n, 2);
        yield* TestClock.adjust("60 seconds");
        assert.strictEqual(calls.n, 3);
      }),
    ),
  );

  it.effect("wake starts the next pass now, and the poll counts from its end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, onePass } = counting();
        const loop = yield* runLoop(onePass, 60);
        yield* TestClock.adjust("30 seconds");
        const next = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
        yield* loop.wake;
        assert.deepStrictEqual(yield* Fiber.join(next), report(2));
        assert.strictEqual(calls.n, 2);
        yield* TestClock.adjust("59 seconds");
        assert.strictEqual(calls.n, 2);
        yield* TestClock.adjust("1 second");
        assert.strictEqual(calls.n, 3);
      }),
    ),
  );

  it.effect("passes never overlap: a wake during a pass makes the next follow it, once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const on = yield* Deferred.make<void>();
        const { calls, onePass } = counting({ at: 2, on });
        const loop = yield* runLoop(onePass, 60);
        yield* TestClock.adjust("60 seconds");
        assert.strictEqual(calls.n, 2);
        yield* loop.wake;
        yield* loop.wake;
        yield* TestClock.adjust("120 seconds");
        assert.strictEqual(calls.n, 2, "the second pass is still running");
        const next = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
        yield* Deferred.succeed(on, undefined);
        assert.deepStrictEqual(yield* Fiber.join(next), report(2));
        // The third pass follows the second at once, in the loop's own fiber.
        yield* Effect.yieldNow;
        assert.strictEqual(calls.n, 3, "one pass follows, not one per wake");
        yield* TestClock.adjust("59 seconds");
        assert.strictEqual(calls.n, 3);
        yield* TestClock.adjust("1 second");
        assert.strictEqual(calls.n, 4);
      }),
    ),
  );

  it.effect("a pass that dies is logged and the loop goes on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = { n: 0 };
        const onePass = Effect.suspend(() => {
          calls.n += 1;
          return calls.n === 1 ? Effect.die(new Error("boom")) : Effect.succeed(report(calls.n));
        });
        const loop = yield* runLoop(onePass, 60);
        assert.strictEqual(calls.n, 1);
        const next = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
        yield* TestClock.adjust("60 seconds");
        assert.deepStrictEqual(yield* Fiber.join(next), report(2));
      }),
    ),
  );

  it.effect("the loop stops with its scope", () =>
    Effect.gen(function* () {
      const { calls, onePass } = counting();
      yield* Effect.scoped(runLoop(onePass, 60));
      assert.strictEqual(calls.n, 1);
      yield* TestClock.adjust("600 seconds");
      assert.strictEqual(calls.n, 1);
    }),
  );
});
