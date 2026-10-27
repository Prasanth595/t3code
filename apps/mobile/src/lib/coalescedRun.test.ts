import { describe, expect, it } from "vite-plus/test";

import { coalescedRun } from "./coalescedRun";

describe("coalescedRun", () => {
  it("runs once more when called while a run is in flight", async () => {
    const runs: Array<PromiseWithResolvers<void>> = [];
    const refresh = coalescedRun(() => {
      const run = Promise.withResolvers<void>();
      runs.push(run);
      return run.promise;
    });

    const first = refresh();
    const joined = refresh();
    refresh();
    expect(joined).toBe(first);
    expect(runs).toHaveLength(1);

    runs[0]!.resolve();
    await first;
    await Promise.resolve();
    expect(runs).toHaveLength(2);

    runs[1]!.resolve();
    await runs[1]!.promise;
    await Promise.resolve();
    expect(runs).toHaveLength(2);
  });

  it("does not run again when nothing was asked during the run", async () => {
    let count = 0;
    const refresh = coalescedRun(async () => {
      count += 1;
    });
    await refresh();
    await Promise.resolve();
    expect(count).toBe(1);
  });
});
