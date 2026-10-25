import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { subscribe, type RpcSession, type WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import { mobileConnectionWakeups } from "./app-state-wakeups";

const native = vi.hoisted(() => ({
  OS: "android",
  currentState: "active",
  listener: (_state: string) => {},
  subscribed: () => {},
  remove: vi.fn(),
}));
vi.mock("react-native", () => ({
  Platform: native,
  AppState: {
    get currentState() {
      return native.currentState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.listener = listener;
      native.subscribed();
      return { remove: native.remove };
    },
  },
}));

describe("mobile connection lifecycle", () => {
  it.effect("seeds active Android subscribers after foregrounding during supervisor setup", () =>
    Effect.gen(function* () {
      native.OS = "android";
      // The supervisor may already have read background before subscribing.
      native.currentState = "active";
      const subscribed = yield* Queue.unbounded<void>();
      native.subscribed = () => {
        Queue.offerUnsafe(subscribed, undefined);
      };
      const events = yield* Queue.unbounded<string>();
      const fiber = yield* mobileConnectionWakeups.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkChild,
      );
      yield* Queue.take(subscribed);
      native.listener("background");
      expect(yield* Queue.take(events)).toBe("application-active-initial");
      expect(yield* Queue.take(events)).toBe("application-suspended");
      yield* Fiber.interrupt(fiber);
      native.subscribed = () => {};
    }),
  );

  it.effect("seeds hidden Android subscribers, ignores inactive, and resumes immediately", () =>
    Effect.gen(function* () {
      native.OS = "android";
      native.currentState = "background";
      native.remove.mockClear();
      const events = yield* Queue.unbounded<string>();
      const fiber = yield* mobileConnectionWakeups.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkChild,
      );
      expect(yield* Queue.take(events)).toBe("application-suspended");
      native.listener("inactive");
      native.listener("active");
      expect(yield* Queue.take(events)).toBe("application-active-probe");
      native.listener("background");
      expect(yield* Queue.take(events)).toBe("application-suspended");
      yield* Fiber.interrupt(fiber);
      expect(native.remove).toHaveBeenCalledOnce();
    }),
  );
});

it.effect("opens one display subscription on an already active Android app", () =>
  Effect.gen(function* () {
    native.OS = "android";
    native.currentState = "active";
    const opened = yield* Ref.make(0);
    const closed = yield* Ref.make(0);
    const ready = yield* Queue.unbounded<void>();
    const session: RpcSession = {
      client: {
        [WS_METHODS.subscribeTerminalEvents]: () =>
          Stream.never.pipe(
            Stream.onStart(
              Ref.update(opened, (n) => n + 1).pipe(Effect.andThen(Queue.offer(ready, undefined))),
            ),
            Stream.ensuring(Ref.update(closed, (n) => n + 1)),
          ),
      } as unknown as WsRpcProtocolClient,
      ready: Effect.void,
      initialConfig: Effect.never,
      subscribeServerConfig: () => Stream.never,
      probe: Effect.void,
      closed: Effect.never,
    };
    const supervisor = {
      target: new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("test"),
        label: "test",
        httpBaseUrl: "https://test.invalid",
        wsBaseUrl: "wss://test.invalid",
      }),
      state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
      session: yield* SubscriptionRef.make(Option.some(session)),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    };
    yield* subscribe(
      WS_METHODS.subscribeTerminalEvents,
      {},
      {
        resubscribe: mobileConnectionWakeups.pipe(
          Stream.filter(Wakeups.shouldResubscribeAfterWakeup),
        ),
      },
    ).pipe(
      Stream.runDrain,
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.forkScoped,
    );
    yield* Queue.take(ready);
    yield* TestClock.adjust("1 millis");
    expect({ opened: yield* Ref.get(opened), closed: yield* Ref.get(closed) }).toEqual({
      opened: 1,
      closed: 0,
    });
    native.listener("background");
    native.listener("active");
    yield* Queue.take(ready);
    yield* TestClock.adjust("1 millis");
    expect({ opened: yield* Ref.get(opened), closed: yield* Ref.get(closed) }).toEqual({
      opened: 2,
      closed: 1,
    });
  }).pipe(Effect.scoped),
);
