// @effect-diagnostics globalDate:off - the benchmark reads the wall clock around each call.
// @effect-diagnostics globalTimers:off - the ticker that measures main-thread blocks is a timer.
// @effect-diagnostics globalTimersInEffect:off - the ticker must be a plain timer: Effect's would run on the loop it measures.
// @effect-diagnostics globalConsole:off - the benchmark prints its numbers for the person reading the run.
import * as Effect from "effect/Effect";

/**
 * Timing for the benchmark in `projectionReads.bench.test.ts`. The clock readings live here, not in
 * the test file, which the wall-clock lint rule covers: a benchmark's numbers are the point.
 */
export interface Measured {
  /** The longest gap between two ticks of a 1 ms timer while the call ran. */
  readonly blockMs: number;
  readonly wallMs: number;
}

/** Wall time alone, for work whose main-thread blocks are not the point (seeding). */
export const timed = <A, E, R>(call: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const start = performance.now();
    yield* call;
    return performance.now() - start;
  });

export const reportWall = (name: string, wallMs: number) =>
  console.log(`bench: ${name}: wall ${wallMs.toFixed(1)} ms`);

const measure = <A, E, R>(call: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    let last = performance.now();
    let blockMs = 0;
    const ticker = setInterval(() => {
      const now = performance.now();
      blockMs = Math.max(blockMs, now - last);
      last = now;
    }, 1);
    const start = performance.now();
    yield* call.pipe(Effect.ensuring(Effect.sync(() => clearInterval(ticker))));
    const end = performance.now();
    return { blockMs: Math.max(blockMs, end - last), wallMs: end - start } satisfies Measured;
  });

/**
 * The repetition with the shortest block. A host loaded by other work preempts the process in any
 * single run, and the gap that remains in the best run is the call's own.
 */
export const best = <A, E, R>(call: Effect.Effect<A, E, R>, repetitions = 5) =>
  Effect.gen(function* () {
    const runs: Array<Measured> = [];
    for (let i = 0; i < repetitions; i += 1) runs.push(yield* measure(call));
    return runs.reduce((a, b) => (b.blockMs < a.blockMs ? b : a));
  });

export const report = (name: string, { blockMs, wallMs }: Measured) =>
  console.log(
    `bench: ${name}: longest main-thread block ${blockMs.toFixed(1)} ms, wall ${wallMs.toFixed(1)} ms`,
  );
