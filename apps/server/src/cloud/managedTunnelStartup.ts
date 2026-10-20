import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { relayRetryAfterMillis } from "./relayResponse.ts";

// "revoked" leads to no action: relinking a deregistered environment is the
// user's call, so startup neither retries nor relinks it.
export type ManagedTunnelRegistrationResult =
  | { readonly status: "not_linked" | "ready" | "unavailable" | "superseded" | "revoked" }
  | {
      readonly status: "recovery_required";
      readonly config: RelayManagedEndpointRuntimeConfig;
    };

export type ManagedTunnelStartupAction =
  | { readonly action: "none" }
  | { readonly action: "reconcile_link" }
  | {
      readonly action: "request_recovery";
      readonly config: RelayManagedEndpointRuntimeConfig;
    };

export function managedTunnelStartupAction(input: {
  readonly wantsCliLink: boolean;
  readonly registration: ManagedTunnelRegistrationResult;
}): ManagedTunnelStartupAction {
  if (input.registration.status === "recovery_required") {
    return {
      action: "request_recovery",
      config: input.registration.config,
    };
  }
  if (input.wantsCliLink && input.registration.status === "not_linked") {
    return { action: "reconcile_link" };
  }
  return { action: "none" };
}

const MANAGED_TUNNEL_REGISTRATION_RETRY_WINDOW = Duration.minutes(10);

// Every host retries against the same relay, so while it is failing the
// retries themselves are load. Backing off to minutes, and never sooner than
// the relay's Retry-After, lets it recover instead of absorbing the storm.
// Not HttpClient.retryTransient: it resends the identical request, and these
// carry proofs that expire after 60 s or single-use link challenges, so each
// retry has to re-run the whole operation.
const RELAY_RETRY_MAX_DELAY = Duration.minutes(5);

export const relayRetrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, RELAY_RETRY_MAX_DELAY)),
  ),
  Schedule.jittered,
  Schedule.modifyDelay(({ duration, input }) => {
    const retryAfterMillis = relayRetryAfterMillis(input);
    return Effect.succeed(
      retryAfterMillis === undefined
        ? duration
        : Duration.max(duration, Duration.millis(retryAfterMillis)),
    );
  }),
);

export const retryManagedTunnelRegistration = <A, E, R>(
  registration: Effect.Effect<A, E, R>,
  isRetryable: (error: E) => boolean,
  onRetryWindowExhausted?: Effect.Effect<void, never, R>,
) => {
  const schedule = relayRetrySchedule;
  const withinWindow = registration.pipe(
    Effect.retry({
      while: isRetryable,
      schedule: schedule.pipe(
        Schedule.upTo({ duration: MANAGED_TUNNEL_REGISTRATION_RETRY_WINDOW }),
      ),
    }),
  );
  if (onRetryWindowExhausted === undefined) return withinWindow;
  return withinWindow.pipe(
    Effect.catchIf(isRetryable, () =>
      onRetryWindowExhausted.pipe(
        Effect.andThen(registration.pipe(Effect.retry({ while: isRetryable, schedule }))),
      ),
    ),
  );
};

// Every managed host shares one relay, so a host stuck in a bad loop must not
// turn into a fleet-wide request storm.
export const MANAGED_TUNNEL_RECOVERY_COOLDOWN = Duration.minutes(2);
const MANAGED_TUNNEL_RECOVERY_MAX_COOLDOWN = Duration.minutes(30);
// A recovery that fixed the tunnel stops the runtime asking for another, so a
// request this long after the cooldown means the previous one worked.
const MANAGED_TUNNEL_RECOVERY_SETTLED_AFTER = Duration.minutes(10);

/**
 * Recovery can only replace the relay-side tunnel. When the connector keeps
 * failing for local reasons (no network, a firewall), the runtime keeps asking
 * and recovery cannot help, so each request that follows right after a
 * recovery doubles the wait, up to 30 minutes.
 */
export function nextManagedTunnelRecoveryCooldown(input: {
  readonly current: Duration.Duration;
  readonly sinceLastRecovery: Duration.Duration;
}): Duration.Duration {
  const settled = Duration.sum(input.current, MANAGED_TUNNEL_RECOVERY_SETTLED_AFTER);
  if (Duration.isGreaterThanOrEqualTo(input.sinceLastRecovery, settled)) {
    return MANAGED_TUNNEL_RECOVERY_COOLDOWN;
  }
  return Duration.min(Duration.times(input.current, 2), MANAGED_TUNNEL_RECOVERY_MAX_COOLDOWN);
}

// Existing hosts register on their first boot after an upgrade, and desktop
// auto-update delivers that boot to many hosts at once. Spread the first
// registration so the relay and Cloudflare see a ramp instead of a spike.
export const MANAGED_TUNNEL_FIRST_REGISTRATION_JITTER = Duration.seconds(30);
