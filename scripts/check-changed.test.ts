import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { defaultConcurrency, runSteps, type Step } from "./check-changed.ts";

const GiB = 1024 ** 3;

describe("check:changed", () => {
  it("bounds the default concurrency by the scarcer of cores and available memory", () => {
    assert.strictEqual(defaultConcurrency(32, 128 * GiB), 16);
    assert.strictEqual(defaultConcurrency(32, 20 * GiB), 3);
    assert.strictEqual(defaultConcurrency(4, 15 * GiB), 2);
    assert.strictEqual(defaultConcurrency(4, 2 * GiB), 1);
    assert.strictEqual(defaultConcurrency(1, 64 * GiB), 1);
  });

  it.effect("keeps weighted steps within the budget and serial steps one at a time", () =>
    Effect.gen(function* () {
      let active = 0;
      let maxActive = 0;
      let serialActive = 0;
      let maxSerial = 0;
      const step = (
        name: string,
        options: { weight?: number; serial?: boolean } = {},
      ): Step<never> => {
        const slots = Math.min(options.weight ?? 1, 3);
        return {
          name,
          ...options,
          run: Effect.gen(function* () {
            active += slots;
            maxActive = Math.max(maxActive, active);
            if (options.serial) maxSerial = Math.max(maxSerial, ++serialActive);
            yield* Effect.sleep("1 second");
            active -= slots;
            if (options.serial) serialActive--;
            return { ok: true, output: "" };
          }),
        };
      };
      const fiber = yield* runSteps(
        [
          step("light 1"),
          // Above the budget, so it holds every slot rather than never starting.
          step("heavy", { weight: 5 }),
          step("pair", { weight: 2 }),
          step("light 2"),
          step("test 1", { serial: true }),
          step("test 2", { serial: true }),
        ],
        { concurrency: 3, timeoutSeconds: 60 },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      const results = yield* Fiber.join(fiber);

      assert.deepStrictEqual(
        results.map((result) => result.outcome),
        ["pass", "pass", "pass", "pass", "pass", "pass"],
      );
      assert.strictEqual(maxActive, 3);
      assert.strictEqual(maxSerial, 1);
    }),
  );

  it.effect("interrupts a step at its timeout and reports TIMEOUT, apart from FAIL", () =>
    Effect.gen(function* () {
      let interrupted = false;
      const fiber = yield* runSteps(
        [
          {
            name: "hangs",
            run: Effect.never.pipe(
              Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))),
            ),
          },
          { name: "fails", run: Effect.succeed({ ok: false, output: "error" }) },
          { name: "passes", run: Effect.succeed({ ok: true, output: "" }) },
        ],
        { concurrency: 3, timeoutSeconds: 10 },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("9 seconds");
      assert.isFalse(interrupted);
      yield* TestClock.adjust("1 second");
      const results = yield* Fiber.join(fiber);

      assert.isTrue(interrupted);
      assert.deepStrictEqual(
        results.map(({ name, outcome, time }) => [name, outcome, time]),
        [
          ["hangs", "TIMEOUT", "killed after 10s"],
          ["fails", "FAIL", "0.0s"],
          ["passes", "pass", "0.0s"],
        ],
      );
    }),
  );
});
