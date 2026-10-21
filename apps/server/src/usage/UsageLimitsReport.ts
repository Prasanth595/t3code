import {
  isProviderAvailable,
  type OrchestratorMcpUsageLimitsResult,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { limitsNotice, remainingPercent } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

type Reading = Pick<
  OrchestratorMcpUsageLimitsResult["providers"][number],
  "checkedAt" | "windows" | "unavailable"
>;

const reading = (limits: ServerProviderUsageLimits): Reading => {
  const notice = limitsNotice(limits);
  return {
    checkedAt: limits.checkedAt,
    windows: limits.windows.map((window) => ({
      id: window.id,
      kind: window.kind,
      label: window.label,
      usedPercent: window.usedPercent,
      remainingPercent: remainingPercent(window),
      resetsAt: window.resetsAt ?? null,
      windowDurationMins: window.windowDurationMins ?? null,
    })),
    unavailable:
      notice === null
        ? null
        : { reason: limits.unavailable?.reason ?? "notReported", message: notice },
  };
};

const providerReading = (provider: ServerProvider): Reading => {
  const unusable = !provider.installed
    ? "This provider is not installed."
    : !isProviderAvailable(provider)
      ? (provider.unavailableReason ?? provider.message ?? "This provider is unavailable.")
      : provider.status === "error" || provider.status === "disabled"
        ? (provider.message ?? `This provider's status is ${provider.status}.`)
        : provider.auth.status === "unauthenticated"
          ? "This provider is not signed in."
          : null;
  if (unusable !== null) {
    return {
      checkedAt: provider.usageLimits?.checkedAt ?? null,
      windows: [],
      unavailable: { reason: "providerUnavailable", message: unusable },
    };
  }
  if (provider.usageLimits === undefined) {
    return {
      checkedAt: null,
      windows: [],
      unavailable: {
        reason: "notReported",
        message: "This provider has not reported usage limits.",
      },
    };
  }
  return reading(provider.usageLimits);
};

const summarizeUsageLimits = (
  providers: ReadonlyArray<ServerProvider>,
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
  now: DateTime.Utc,
): OrchestratorMcpUsageLimitsResult => ({
  createdAt: DateTime.formatIso(now),
  providers: providers
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      providerInstanceId: provider.instanceId,
      driverKind: provider.driver,
      displayName: provider.displayName?.trim() || null,
      email: provider.auth.email ?? null,
      plan: provider.auth.label ?? null,
      ...providerReading(provider),
    })),
  pooledAccounts: sources.flatMap((source) =>
    source.accounts.map((account) => ({
      sourceLabel: source.label,
      accountId: account.id,
      driverKind: account.driver,
      email: account.email ?? null,
      plan: account.plan ?? null,
      ...reading(account.usageLimits),
    })),
  ),
  notices: sources.flatMap((source) =>
    source.error === undefined ? [] : [`${source.label}: ${source.error}`],
  ),
});

export class UsageLimitsReport extends Context.Service<
  UsageLimitsReport,
  {
    readonly read: (input: {
      readonly refresh: boolean;
    }) => Effect.Effect<OrchestratorMcpUsageLimitsResult>;
  }
>()("t3/usage/UsageLimitsReport") {}

const make = Effect.gen(function* () {
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;

  const read = Effect.fn("UsageLimitsReport.read")(function* (input: {
    readonly refresh: boolean;
  }) {
    if (input.refresh) {
      yield* Effect.all(
        [providerRegistry.refresh(undefined, { fresh: true }), usageLimitSources.refresh],
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    }
    const [providers, sources] = yield* Effect.all([
      providerRegistry.getProviders,
      usageLimitSources.current,
    ]);
    return summarizeUsageLimits(providers, sources, yield* DateTime.now);
  });

  return UsageLimitsReport.of({ read });
});

export const layer = Layer.effect(UsageLimitsReport, make);
