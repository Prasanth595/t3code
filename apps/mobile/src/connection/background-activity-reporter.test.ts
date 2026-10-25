import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as MobileStorage from "../persistence/mobile-storage";
import { layerReporter } from "./background-activity";

const native = vi.hoisted(() => ({
  OS: "android",
  state: "active",
  listeners: new Set<(state: string) => void>(),
}));
vi.mock("react-native", () => ({
  Platform: native,
  AppState: {
    get currentState() {
      return native.state;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.listeners.add(listener);
      return { remove: () => native.listeners.delete(listener) };
    },
  },
}));
vi.mock("../persistence/mobile-storage", async () => {
  const Context = await import("effect/Context");
  return {
    MobileStorage: class extends Context.Service<
      never,
      { loadOrCreateAgentAwarenessDeviceId: Effect.Effect<string> }
    >()("TestMobileStorage") {},
  };
});

const mount = Effect.fnUntraced(function* () {
  const reports = yield* Queue.unbounded<void>();
  const entries = yield* SubscriptionRef.make(new Map([[EnvironmentId.make("environment"), {}]]));
  yield* Layer.build(layerReporter).pipe(
    Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, {
      entries,
      run: () => Queue.offer(reports, undefined),
    } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
    Effect.provideService(MobileStorage.MobileStorage, {
      loadOrCreateAgentAwarenessDeviceId: Effect.succeed("device"),
    } as unknown as MobileStorage.MobileStorage["Service"]),
  );
  return reports;
});
const change = (state: string) => {
  native.state = state;
  native.listeners.forEach((listener) => listener(state));
};

describe("mobile activity reporter lifecycle", () => {
  it.effect("stops periodic Android reports while hidden and restarts once on resume", () =>
    Effect.gen(function* () {
      native.OS = "android";
      native.state = "active";
      const reports = yield* mount();
      yield* TestClock.adjust("251 millis");
      yield* Queue.take(reports);
      change("background");
      yield* TestClock.adjust("10 minutes");
      expect(yield* Queue.size(reports)).toBe(0);
      change("active");
      yield* TestClock.adjust("251 millis");
      expect(yield* Queue.size(reports)).toBe(1);
    }).pipe(Effect.scoped),
  );
  it.effect("preserves iOS hidden activity reporting", () =>
    Effect.gen(function* () {
      native.OS = "ios";
      native.state = "background";
      const reports = yield* mount();
      yield* TestClock.adjust("251 millis");
      expect(yield* Queue.size(reports)).toBe(1);
    }).pipe(Effect.scoped),
  );
});
