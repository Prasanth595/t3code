/**
 * Fork: an app token client pairs again by itself (MM-921). A machine ends the sessions of a
 * client at each level change, at the expiry of its arrow and at a `clientAccess` change
 * (MM-912, MM-921). The app then holds a refused session, so it asks the machine for a new
 * pairing credential with its saved token headers and pairs again.
 *
 * At start and each time the app returns to the foreground, the repair also reads the machines
 * of the client from the portal (MM-914): it pairs with a machine that gained an arrow and
 * disables the environment of a machine whose arrow is `none`.
 */
import {
  cloudflareAccessServiceToken,
  ConnectionOnboarding,
  type ConnectionCatalogEntry,
  connectionRoutes,
  EnvironmentRegistry,
  requestHeaderOrigin,
  routeHttpBaseUrl,
} from "@t3tools/client-runtime/connection";
import { ClientMachinesResponse, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult } from "effect/reactivity";
import { AppState } from "react-native";

import { buildPairingUrl } from "../features/connection/pairing";
import { appAtomRegistry } from "../state/atom-registry";
import {
  appTokenEnvironmentIdsAtom,
  appTokenRepairErrorAtom,
} from "../state/forkAppTokenRepairErrors";
import type { AppTokenClient } from "../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../state/preferences";
import { issueMachinePairingCredential } from "./clientEnroll";
import {
  appTokenOrigins,
  type AppTokenEnvironment,
  isRefusedSession,
  NO_ACCESS_MESSAGE,
  REPAIRING_MESSAGE,
  planMachineSync,
  repairDelayMs,
  TOKEN_REFUSED_MESSAGE,
} from "./forkAppTokenClient";
import { fetchWithRequestHeaders, requestHeaderRules } from "./requestHeaders";

const decodeMachines = Schema.decodeUnknownOption(Schema.toCodecJson(ClientMachinesResponse));

type PortalAnswer =
  | {
      readonly _tag: "machines";
      readonly machinesUrl: string;
      readonly tokenClientId: string;
      readonly answer: ClientMachinesResponse;
    }
  | { readonly _tag: "refused" }
  | { readonly _tag: "none" };

/**
 * The portal is the origin whose `GET /client/machines` answers with the machine list. A phone
 * without an app token has no such origin. The portal answers 403 for a removed client, and
 * Cloudflare Access refuses a deleted token on every origin.
 */
const readPortal = Effect.fn("mobile.appTokenRepair.readPortal")(function* (
  savedMachinesUrl: string | null,
) {
  const savedOrigin = savedMachinesUrl === null ? null : requestHeaderOrigin(savedMachinesUrl);
  // The enrollment saves the machine list URL. A phone enrolled before that finds it by asking
  // each origin that holds a token.
  const rules = requestHeaderRules().filter(
    (rule) =>
      cloudflareAccessServiceToken(rule.headers) !== null &&
      (savedOrigin === null || rule.origin === savedOrigin),
  );
  let refused = 0;
  for (const rule of rules) {
    const machinesUrl = savedMachinesUrl ?? `${rule.origin}/client/machines`;
    const response = yield* Effect.tryPromise(() => fetchWithRequestHeaders(machinesUrl)).pipe(
      Effect.option,
    );
    if (Option.isNone(response)) continue;
    const { status } = response.value;
    const finalHost = (() => {
      try {
        return new URL(response.value.url).hostname;
      } catch {
        return "";
      }
    })();
    if (status === 401 || status === 403 || finalHost.endsWith(".cloudflareaccess.com")) {
      refused++;
      continue;
    }
    if (!response.value.ok) continue;
    const body = yield* Effect.tryPromise(() => response.value.json()).pipe(Effect.option);
    const answer = Option.flatMap(body, decodeMachines);
    if (Option.isSome(answer)) {
      const token = cloudflareAccessServiceToken(rule.headers);
      if (token === null) continue;
      return {
        _tag: "machines",
        machinesUrl,
        tokenClientId: token.clientId,
        answer: answer.value,
      } as PortalAnswer;
    }
  }
  return (
    rules.length > 0 && refused === rules.length ? { _tag: "refused" } : { _tag: "none" }
  ) as PortalAnswer;
});

/** The machine origin of each saved environment with a bearer route. */
function bearerOrigin(entry: ConnectionCatalogEntry): string | null {
  for (const route of connectionRoutes(entry)) {
    if (route.target._tag !== "BearerConnectionTarget") continue;
    const httpBaseUrl = routeHttpBaseUrl(route);
    const origin = httpBaseUrl === null ? null : requestHeaderOrigin(httpBaseUrl);
    if (origin !== null) return origin;
  }
  return null;
}

function setError(environmentId: EnvironmentId, message: string | null): void {
  appAtomRegistry.set(appTokenRepairErrorAtom(environmentId), message);
}

function savedClient(): AppTokenClient | null {
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences) ? (preferences.value.appTokenClient ?? null) : null;
}

let requestSyncFromApp: (() => void) | null = null;

/** Reads the machine list from the portal now: after an enrollment, or from "Refresh machines". */
export function requestAppTokenSync(): void {
  requestSyncFromApp?.();
}

function disabledByRepair(): ReadonlySet<EnvironmentId> {
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  return new Set(
    (AsyncResult.isSuccess(preferences)
      ? (preferences.value.appTokenDisabledEnvironmentIds ?? [])
      : []) as ReadonlyArray<EnvironmentId>,
  );
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
    const syncRequests = yield* Queue.sliding<void>(1);
    const requestSync = () => Queue.offerUnsafe(syncRequests, undefined);
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        requestSyncFromApp = requestSync;
      }),
      () =>
        Effect.sync(() => {
          requestSyncFromApp = null;
        }),
    );
    // The client id of the app token, once the portal answered with it.
    let tokenClientId: string | null = null;

    const pair = (origin: string, expectedEnvironmentId?: EnvironmentId) =>
      Effect.tryPromise(() => issueMachinePairingCredential(origin)).pipe(
        Effect.flatMap((credential) =>
          onboarding.registerPairing({
            pairingUrl: buildPairingUrl(origin, credential),
            ...(expectedEnvironmentId === undefined ? {} : { expectedEnvironmentId }),
          }),
        ),
      );

    const savedAppTokenEnvironments = Effect.gen(function* () {
      if (tokenClientId === null) return [] as ReadonlyArray<AppTokenEnvironment>;
      const origins = appTokenOrigins(requestHeaderRules(), tokenClientId);
      const entries = yield* SubscriptionRef.get(registry.entries);
      const saved: AppTokenEnvironment[] = [];
      for (const [environmentId, entry] of entries) {
        const origin = bearerOrigin(entry);
        if (origin !== null && origins.has(origin)) {
          saved.push({ environmentId, origin, enabled: entry.enabled });
        }
      }
      return saved;
    });

    const sync = Effect.gen(function* () {
      const saved = savedClient();
      const portal = yield* readPortal(saved?.machinesUrl ?? null);
      if (portal._tag === "none") return;
      if (portal._tag === "refused") {
        // Access refused the token on every origin that holds one, so each of them is affected.
        const tokenOrigins = new Set(
          requestHeaderRules()
            .filter((rule) => cloudflareAccessServiceToken(rule.headers) !== null)
            .map((rule) => rule.origin),
        );
        for (const [environmentId, entry] of yield* SubscriptionRef.get(registry.entries)) {
          const origin = bearerOrigin(entry);
          if (origin !== null && tokenOrigins.has(origin)) {
            setError(environmentId, TOKEN_REFUSED_MESSAGE);
          }
        }
        return;
      }
      const token = portal.tokenClientId;
      tokenClientId = token;
      if (saved?.machinesUrl !== portal.machinesUrl) {
        appAtomRegistry.set(updateMobilePreferencesAtom, {
          appTokenClient: { ...saved, machinesUrl: portal.machinesUrl },
        });
      }
      const machines = portal.answer.machines.flatMap((machine) => {
        const origin = requestHeaderOrigin(machine.origin);
        return origin === null ? [] : [{ ...machine, origin }];
      });
      const disabled = disabledByRepair();
      const savedEnvironments = yield* savedAppTokenEnvironments;
      appAtomRegistry.set(
        appTokenEnvironmentIdsAtom,
        savedEnvironments.map((environment) => environment.environmentId),
      );
      const plan = planMachineSync({
        machines,
        saved: savedEnvironments,
        disabledByRepair: disabled,
      });
      for (const environmentId of plan.disable) {
        yield* registry.setEnabled(environmentId, false).pipe(Effect.ignore);
        setError(environmentId, NO_ACCESS_MESSAGE);
      }
      for (const environmentId of plan.enable) {
        yield* registry.setEnabled(environmentId, true).pipe(Effect.ignore);
        setError(environmentId, null);
      }
      const nextDisabled = new Set([...disabled, ...plan.disable]);
      for (const environmentId of plan.enable) nextDisabled.delete(environmentId);
      if (nextDisabled.size !== disabled.size || plan.enable.length > 0) {
        appAtomRegistry.set(updateMobilePreferencesAtom, {
          appTokenDisabledEnvironmentIds: [...nextDisabled],
        });
      }
      // A machine that gained an arrow; it needs the token headers for its origin first.
      for (const machine of plan.pair) {
        if (!appTokenOrigins(requestHeaderRules(), token).has(machine.origin)) continue;
        yield* pair(machine.origin).pipe(Effect.ignore);
      }
    }).pipe(Effect.withSpan("mobile.appTokenRepair.sync"));

    /** Pairs again until the session works, the environment leaves, or the token is refused. */
    const repair = Effect.fn("mobile.appTokenRepair.repair")(function* (
      environmentId: EnvironmentId,
    ) {
      for (let failures = 0; ; failures++) {
        if (failures > 0) {
          // "Retry now" leaves the blocked state: stop waiting, so the refusal that follows
          // pairs again at once instead of after the backoff.
          yield* Effect.raceFirst(
            Effect.sleep(repairDelayMs(failures)),
            registry.stateChanges(environmentId).pipe(
              Stream.filter((state) => state.phase !== "blocked"),
              Stream.runHead,
              Effect.ignore,
            ),
          );
        }
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
        const state = yield* registry.state(environmentId).pipe(Effect.option);
        // The environment left, or connected again in the meantime.
        if (entry === undefined || !entry.enabled) return;
        if (Option.isNone(state) || !isRefusedSession(state.value)) return;
        if (tokenClientId === null) yield* sync;
        const origin = bearerOrigin(entry);
        if (
          tokenClientId === null ||
          origin === null ||
          !appTokenOrigins(requestHeaderRules(), tokenClientId).has(origin)
        ) {
          return;
        }
        // A retry keeps the reason of an earlier failure, such as a refused token, on screen.
        if (appAtomRegistry.get(appTokenRepairErrorAtom(environmentId)) === null) {
          setError(environmentId, REPAIRING_MESSAGE);
        }
        const paired = yield* pair(origin, environmentId).pipe(Effect.exit);
        if (paired._tag === "Success") {
          setError(environmentId, null);
          yield* registry.retryNow(environmentId);
          return;
        }
        // The machine refused the pairing: read the portal for why (token gone, or no arrow).
        yield* sync;
      }
    });

    const watched = new Map<EnvironmentId, Fiber.Fiber<void, unknown>>();
    const watch = (environmentId: EnvironmentId) =>
      registry.stateChanges(environmentId).pipe(
        Stream.filter(isRefusedSession),
        // A repair runs at most once at a time per environment; blocked states during it wait.
        Stream.runForEach(() => repair(environmentId)),
        Effect.ignore,
      );

    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.runForEach((entries) =>
        Effect.gen(function* () {
          for (const [environmentId, fiber] of watched) {
            if (entries.has(environmentId)) continue;
            yield* Fiber.interrupt(fiber);
            watched.delete(environmentId);
          }
          let added = false;
          for (const environmentId of entries.keys()) {
            if (watched.has(environmentId)) continue;
            watched.set(environmentId, yield* Effect.forkScoped(watch(environmentId)));
            added = true;
          }
          // The saved catalog, with its token headers, loads after start: sync once it is there.
          if (added) requestSync();
        }),
      ),
      Effect.forkScoped,
    );

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        AppState.addEventListener("change", (state) => {
          if (state === "active") requestSync();
        }),
      ),
      (subscription) => Effect.sync(() => subscription.remove()),
    );
    yield* Stream.fromQueue(syncRequests).pipe(
      Stream.debounce("500 millis"),
      Stream.runForEach(() => sync.pipe(Effect.ignoreCause)),
      Effect.forkScoped,
    );
    requestSync();
  }),
);
