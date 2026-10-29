import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ServerSettings,
  type UsageLimitSourceConfig,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as Settings from "../serverSettings.ts";
import { makeCliproxyApi } from "./cliproxyApi.ts";

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly refresh: Effect.Effect<void>;
    readonly resolveResetAt: (input: {
      readonly endpoint: string;
      readonly model: string;
    }) => Effect.Effect<string | null>;
    readonly consumeResetCredit: (
      input: UsageLimitSourceConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
  }
>()("t3/usage/UsageLimitSources") {}

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  const fallback = id.trim() || "Usage limit source";
  try {
    return new URL(config.url).host || fallback;
  } catch {
    return fallback;
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const settingsService = yield* Settings.ServerSettingsService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const stateRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = { id, kind: config.kind, label: sourceLabel(id, config), checkedAt } as const;
    if (config.managementKey.length === 0) {
      return { ...base, accounts: [], error: "No management key configured." };
    }
    const accounts = yield* api.readAccounts(config).pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      return { ...base, accounts: [], error: accounts.failure.detail };
    }
    return { ...base, accounts: accounts.success };
  });

  const publish = Effect.fn("UsageLimitSources.publish")(function* (
    next: ReadonlyArray<UsageLimitSourceSnapshot>,
  ) {
    const changed = yield* Ref.modify(stateRef, (previous) =>
      Equal.equals(previous, next) ? [false, previous] : [true, next],
    );
    if (changed) yield* PubSub.publish(changes, next);
  });

  // Serialize refreshes so slow old-settings reads cannot resurrect removed sources after newer refreshes.
  const refreshLock = yield* Semaphore.make(1);
  const refresh = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const entries = Object.entries(settings?.usageLimitSources ?? {}).filter(
      ([, config]) => config.enabled,
    );
    const snapshots = yield* Effect.forEach(
      entries,
      ([id, config]) => readSource(id as UsageLimitSourceId, config),
      { concurrency: 4 },
    );
    yield* publish(snapshots);
  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));

  // Shares the refresh lock so a stale in-flight read cannot overwrite a redemption.
  const consumeResetCredit = Effect.fn("UsageLimitSources.consumeResetCredit")(function* (
    input: UsageLimitSourceConsumeResetCreditInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not read hub settings." })),
    );
    const config = settings.usageLimitSources[input.sourceId];
    if (!config?.enabled || !config.managementKey) {
      return yield* new UsageLimitSourceError({
        detail: "The usage limit source is missing or disabled.",
      });
    }
    const result = yield* api.consume(config, input.accountId, input.creditId);
    const snapshot = yield* readSource(input.sourceId, config);
    const previous = yield* Ref.get(stateRef);
    yield* publish(previous.map((source) => (source.id === input.sourceId ? snapshot : source)));
    return result;
  }, refreshLock.withPermits(1));

  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.usageLimitSources),
    Stream.changes,
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  yield* Effect.forever(
    interval.pipe(
      Effect.flatMap((wait) => Effect.sleep(Duration.isPositive(wait) ? wait : "60 seconds")),
      Effect.andThen(interval),
      Effect.flatMap((current) =>
        Duration.isPositive(current)
          ? backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })
          : Effect.succeed(false),
      ),
      Effect.flatMap((shouldRun) => (shouldRun ? refresh : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* refresh.pipe(Effect.forkScoped);

  const resolveResetAt = Effect.fn("UsageLimitSources.resolveResetAt")(
    function* (input: { readonly endpoint: string; readonly model: string }) {
      const endpoint = URL.parse(input.endpoint);
      if (!endpoint || !["http:", "https:"].includes(endpoint.protocol)) return null;
      const settings = yield* settingsService.getSettings;
      const entries = Object.entries(settings.usageLimitSources).filter(([, config]) => {
        const hub = URL.parse(config.url);
        if (!config.enabled || !config.managementKey || !hub || hub.origin !== endpoint.origin)
          return false;
        const basePath = hub.pathname.replace(/\/$/, "");
        return endpoint.pathname === basePath || endpoint.pathname.startsWith(`${basePath}/`);
      });
      if (entries.length !== 1) return null;
      const [id, config] = entries[0]!;
      const snapshot = yield* readSource(id as UsageLimitSourceId, config);
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const resets = yield* Effect.forEach(
        snapshot.accounts.filter((account) => account.driver === "claudeAgent"),
        (account) =>
          Effect.gen(function* () {
            const models = yield* api.accountModels(config, account.id);
            const modelId = models.includes(input.model)
              ? input.model
              : input.model.replace(/\[1m\]$/, "");
            if (!models.includes(modelId) || account.usageLimits.unavailable) return null;
            const model = modelId.replace(/^claude-/, "").replace(/[^a-z0-9]+/g, "_");
            const blocked = account.usageLimits.windows.filter((window) => {
              if (window.usedPercent < 100) return false;
              if (window.id === "five_hour" || window.id === "seven_day") return true;
              const scope = window.id.replace(/^seven_day_/, "").replace(/^claude_/, "");
              if (!/^(opus|sonnet|haiku)(_|$)/.test(scope)) return true;
              return model === scope || model.startsWith(`${scope}_`);
            });
            if (
              blocked.length === 0 ||
              blocked.some((window) => !window.resetsAt || Date.parse(window.resetsAt) <= now)
            )
              return null;
            return Math.max(...blocked.map((window) => Date.parse(window.resetsAt!)));
          }).pipe(Effect.orElseSucceed(() => null)),
        { concurrency: 4 },
      );
      const known = resets.filter((reset) => reset !== null);
      return known.length === 0
        ? null
        : DateTime.formatIso(DateTime.makeUnsafe(Math.min(...known)));
    },
    Effect.timeout("15 seconds"),
    Effect.orElseSucceed(() => null),
  );

  return {
    current: Ref.get(stateRef),
    resolveResetAt,
    consumeResetCredit,
    refresh,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  } satisfies UsageLimitSources["Service"];
});

export const layer = Layer.effect(UsageLimitSources, make);
