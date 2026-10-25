import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { EnvironmentRpcSubscriptionObserver, request } from "@t3tools/client-runtime/rpc";
import {
  type BackgroundScope,
  type ClientActivityReportInput,
  type EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AppState, Platform } from "react-native";

import * as MobileStorage from "../persistence/mobile-storage";
import {
  observeMobileBackgroundActivitySubscription,
  onRetainedMobileBackgroundScopesChange,
  retainedMobileBackgroundScopes,
} from "./background-activity-scopes";

const REPORT_INTERVAL_MS = 25_000;
const LEASE_TTL_MS = 45_000;
const BASELINE_SCOPES: ReadonlyArray<BackgroundScope> = [{ type: "provider-status" }];

function normalizeAppState(
  state: string | null | undefined,
): NonNullable<ClientActivityReportInput["appState"]> {
  if (state === "active" || state === "inactive" || state === "background") return state;
  return "unknown";
}

export const layerObserver = Layer.succeed(
  EnvironmentRpcSubscriptionObserver,
  EnvironmentRpcSubscriptionObserver.of({
    observe: observeMobileBackgroundActivitySubscription,
  }),
);

export const layerReporter = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const storage = yield* MobileStorage.MobileStorage;
    const clientId = yield* storage.loadOrCreateAgentAwarenessDeviceId.pipe(
      Effect.map((deviceId) => `mobile-${deviceId}`),
      Effect.orElseSucceed(() => "ephemeral-mobile-client"),
    );
    const reportRequests = yield* Queue.sliding<void>(1);
    let appState = AppState.currentState;
    const requestReport = () => {
      if (Platform.OS !== "android" || appState === "active")
        Queue.offerUnsafe(reportRequests, undefined);
    };

    const report = Effect.gen(function* () {
      // Closing the Android transport ends its lease. Do not queue new RPCs
      // while hidden; the server TTL handles a process killed before cleanup.
      if (Platform.OS === "android" && appState !== "active") return;
      const observedAtMs = yield* Clock.currentTimeMillis;
      const active = appState === "active";
      const entries = yield* SubscriptionRef.get(registry.entries);
      yield* Effect.forEach(
        entries.keys(),
        (environmentId) =>
          registry
            .run(
              environmentId,
              request(WS_METHODS.serverReportClientActivity, {
                environmentId: environmentId as EnvironmentId,
                clientId,
                clientKind: "mobile",
                visible: active,
                focused: active,
                recentlyInteracted: active,
                appState: normalizeAppState(appState),
                scopes: [
                  ...BASELINE_SCOPES,
                  ...retainedMobileBackgroundScopes(environmentId as EnvironmentId),
                ],
                ttlMs: LEASE_TTL_MS,
                observedAt: DateTime.makeUnsafe(observedAtMs),
              }),
            )
            // Not `ignore`: tearing down an environment mid-request interrupts its report,
            // and an interrupt leaking out here would end the reporting loop for good.
            .pipe(Effect.ignoreCause),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.withSpan("mobile.backgroundActivity.report"));

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const removeScopeListener = onRetainedMobileBackgroundScopesChange(requestReport);
        const subscription = AppState.addEventListener("change", (nextState) => {
          appState = nextState;
          requestReport();
        });
        return { removeScopeListener, subscription };
      }),
      ({ removeScopeListener, subscription }) =>
        Effect.sync(() => {
          removeScopeListener();
          subscription.remove();
        }),
    );
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.runForEach(() => Effect.sync(requestReport)),
      Effect.forkScoped,
    );
    yield* Stream.fromQueue(reportRequests).pipe(
      Stream.debounce("250 millis"),
      Stream.runForEach(() => report),
      Effect.forkScoped,
    );
    yield* Stream.callback<boolean>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          Queue.offerUnsafe(queue, Platform.OS !== "android" || AppState.currentState === "active");
          return AppState.addEventListener("change", (state) =>
            Queue.offerUnsafe(queue, Platform.OS !== "android" || state === "active"),
          );
        }),
        (subscription) => Effect.sync(() => subscription.remove()),
      ).pipe(Effect.asVoid),
    ).pipe(
      Stream.changes,
      Stream.switchMap((active) => (active ? Stream.tick(REPORT_INTERVAL_MS) : Stream.empty)),
      Stream.runForEach(() => Effect.sync(requestReport)),
      Effect.forkScoped,
    );
  }),
);
