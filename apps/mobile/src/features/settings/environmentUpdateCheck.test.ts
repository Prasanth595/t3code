import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { environmentReleaseCheckAtom, releaseCheckError } from "./environmentUpdateCheck";

function stubHangingFetch() {
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    "fetch",
    (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signals.push(init.signal);
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      }),
  );
  return Object.assign(signals, { [Symbol.dispose]: () => vi.unstubAllGlobals() });
}

async function settleMicrotasks() {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

function makeRegistry() {
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => undefined;
    },
  });
  const flush = () => {
    for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
  };
  return { registry, flush };
}

describe("environmentReleaseCheckAtom", () => {
  it("aborts the release lookup when the screen stops reading it", async () => {
    using signals = stubHangingFetch();
    const { registry, flush } = makeRegistry();
    const atom = environmentReleaseCheckAtom(EnvironmentId.make("env-unmount"));
    const unmount = registry.mount(atom);

    registry.set(atom, async () => "0.0.40");
    await settleMicrotasks();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    unmount();
    flush();
    expect(signals[0]?.aborted).toBe(true);
  });

  it("reports a timeout in words after 20 seconds", async () => {
    using signals = stubHangingFetch();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    vi.useFakeTimers();
    const { registry, flush } = makeRegistry();
    const atom = environmentReleaseCheckAtom(EnvironmentId.make("env-timeout"));
    const unmount = registry.mount(atom);

    registry.set(atom, async () => "0.0.40");
    await settleMicrotasks();
    expect(signals).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(signals[0]?.aborted).toBe(true);
    expect(releaseCheckError(registry.get(atom))).toBe(
      "Checking for updates timed out. Try again.",
    );
    unmount();
    flush();
  });
});
