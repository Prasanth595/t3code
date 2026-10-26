import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";

import { RelayRequestError, shouldRetryRelayRequest } from "./relayResponse.ts";

import {
  makeManagedTunnelRecovery,
  retryDesiredLinkReconcile,
  retryManagedTunnelRegistration,
} from "./managedTunnelStartup.ts";

describe("retryManagedTunnelRegistration", () => {
  it.effect("does not fall back or retry when registration is permanently rejected", () =>
    Effect.gen(function* () {
      let attempts = 0;
      let fallbacks = 0;
      const error = yield* Effect.flip(
        retryManagedTunnelRegistration(
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail("not authorized");
          }),
          () => false,
          Effect.sync(() => {
            fallbacks += 1;
          }),
        ),
      );
      expect(error).toBe("not authorized");
      expect(attempts).toBe(1);
      expect(fallbacks).toBe(0);
    }),
  );
});

it.effect("retries a desired link past ten minutes and accepts clock correction", () =>
  Effect.gen(function* () {
    const exhausted = yield* Deferred.make<void>();
    let corrected = false;
    const error = new RelayRequestError({
      rejection: "unauthorized",
      description: "clock skew",
      clockSkewSeconds: -420,
    });
    const pending = yield* retryDesiredLinkReconcile(
      Effect.suspend(() => (corrected ? Effect.succeed("managed") : Effect.fail(error))),
      shouldRetryRelayRequest,
      () => Deferred.succeed(exhausted, undefined),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("15 minutes");
    yield* Deferred.await(exhausted);
    corrected = true;
    yield* TestClock.adjust("5 minutes");
    expect(yield* Fiber.join(pending)).toBe("managed");
  }),
);

it.effect("keeps the recovery cooldown through wall-clock corrections", () =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    let wallOffset = 0;
    const hostClock = {
      ...clock,
      currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe() + wallOffset),
    };
    const config = {
      providerKind: "cloudflare_tunnel" as const,
      connectorToken: "token",
      tunnelId: "tunnel",
    };
    let attempts = 0;
    const recover = yield* makeManagedTunnelRecovery({
      recover: () => Effect.sync(() => ++attempts),
      isRetryable: () => false,
    });
    yield* recover(config).pipe(Effect.provideService(Clock.Clock, hostClock));
    wallOffset = 3_600_000;
    const pending = yield* recover(config).pipe(
      Effect.provideService(Clock.Clock, hostClock),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* TestClock.adjust("239 seconds");
    expect(attempts).toBe(1);
    wallOffset = -3_600_000;
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(pending)).toBe(2);
  }),
);
