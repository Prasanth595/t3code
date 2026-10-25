import type { Wakeups } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { AppState, Platform } from "react-native";

export const MOBILE_BACKGROUND_RECONNECT_AFTER_MS = 10_000;

export type MobileApplicationActiveWakeup = Extract<
  Wakeups.ConnectionWakeup,
  "application-active-probe" | "application-active-reconnect"
>;

export function mobileApplicationActiveWakeup(
  backgroundedAtMs: number | null,
  activeAtMs: number,
): MobileApplicationActiveWakeup {
  return backgroundedAtMs !== null &&
    activeAtMs - backgroundedAtMs >= MOBILE_BACKGROUND_RECONNECT_AFTER_MS
    ? "application-active-reconnect"
    : "application-active-probe";
}

export const mobileConnectionWakeups = Stream.callback<Wakeups.ConnectionWakeup>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let backgroundedAtMs = AppState.currentState === "background" ? Date.now() : null;
      // Reconcile both directions: AppState may have changed since the
      // supervisor read its initial suspension state.
      if (Platform.OS === "android") {
        Queue.offerUnsafe(
          queue,
          AppState.currentState === "background"
            ? "application-suspended"
            : "application-active-initial",
        );
      }
      return AppState.addEventListener("change", (state) => {
        if (state === "background") {
          backgroundedAtMs = Date.now();
          if (Platform.OS === "android") Queue.offerUnsafe(queue, "application-suspended");
          return;
        }
        if (state === "active") {
          Queue.offerUnsafe(queue, mobileApplicationActiveWakeup(backgroundedAtMs, Date.now()));
          backgroundedAtMs = null;
        }
      });
    }),
    (subscription) => Effect.sync(() => subscription.remove()),
  ).pipe(Effect.asVoid),
);
