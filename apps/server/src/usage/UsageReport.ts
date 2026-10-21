import {
  isProviderAvailable,
  type EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type OrchestratorMcpUsageLimits,
  type OrchestratorMcpUsageResult,
  type OrchestratorMcpUsageSpend,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageProviderKind,
  type UsageSummary,
  type UsageTokenTotals,
  type UsageSourceFingerprint,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { limitsNotice, remainingPercent } from "@t3tools/shared/usageLimits";
import { isModelCostUnknown, mergeUsage } from "@t3tools/shared/usageMerge";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import * as UsageService from "./UsageService.ts";

type Reading = Pick<
  OrchestratorMcpUsageLimits["providers"][number],
  "checkedAt" | "windows" | "unavailable"
>;
type SpendDays = OrchestratorMcpUsageSpend["window"]["days"];

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

const summarizeLimits = (
  providers: ReadonlyArray<ServerProvider>,
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
): OrchestratorMcpUsageLimits => ({
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
});

const usd = (value: number) => Math.round(value * 100) / 100;
const share = (value: number) => Math.round(value * 1_000) / 1_000;

const tokens = (totals: UsageTokenTotals) => ({
  total:
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens,
  uncachedInput: totals.uncachedInputTokens,
  cachedInput: totals.cachedInputTokens,
  cacheCreation: totals.cacheCreationTokens,
  output: totals.outputTokens,
  reasoning: totals.reasoningTokens,
});

const periodProviders = (
  byProvider: ReadonlyMap<UsageProviderKind, { costUsd: number; totalTokens: number }>,
) =>
  [...byProvider].map(([provider, amount]) => ({
    provider,
    costUsd: usd(amount.costUsd),
    totalTokens: amount.totalTokens,
  }));

const sourceName = (fingerprint: UsageSourceFingerprint) =>
  `${fingerprint.provider} usage (${fingerprint.resolvedHomePath})`;

const summarizeSpend = (
  summary: UsageSummary,
  environment: { readonly environmentId: EnvironmentId; readonly label: string },
  days: SpendDays,
): { readonly spend: OrchestratorMcpUsageSpend; readonly notices: ReadonlyArray<string> } => {
  const merged = mergeUsage([{ ...environment, summary }], USAGE_CONTRACT_VERSION);
  const hourly = days === 1;
  return {
    spend: {
      window: {
        days,
        resolution: hourly ? "hour" : "day",
        sinceDay: summary.sinceDay,
        untilDay: summary.untilDay,
        timeZone: summary.timeZone,
      },
      costUsd: usd(merged.costUsd),
      cacheSavingsUsd: usd(merged.costQuality.cacheSavingsUsd),
      unpricedShare: share(merged.costQuality.unpricedShare),
      sessions: merged.sessions,
      tokens: tokens({
        uncachedInputTokens: merged.uncachedInputTokens,
        cachedInputTokens: merged.cachedInputTokens,
        cacheCreationTokens: merged.cacheCreationTokens,
        outputTokens: merged.outputTokens,
        reasoningTokens: merged.reasoningTokens,
      }),
      costByCategoryUsd: {
        input: usd(merged.categoryCost.input),
        cacheRead: usd(merged.categoryCost.cacheRead),
        cacheWrite: usd(merged.categoryCost.cacheWrite),
        output: usd(merged.categoryCost.output),
        unsplit: usd(merged.categoryCost.unsplit),
      },
      costBySpeedUsd: {
        standard: usd(merged.speedCost.standard),
        fast: usd(merged.speedCost.fast),
        ultrafast: usd(merged.speedCost.ultrafast),
        premium: usd(merged.speedCost.premium),
      },
      providers: merged.providers.map((provider) => ({
        provider: provider.provider,
        costUsd: usd(provider.costUsd),
        totalTokens: provider.totalTokens,
        sessions: provider.sessions,
      })),
      models: merged.models.map((model) => ({
        provider: model.provider,
        model: model.model,
        costUsd: isModelCostUnknown(model) ? null : usd(model.costUsd),
        tokens: tokens(model.tokens),
      })),
      periods: hourly
        ? merged.hourly.map((period) => ({
            start: period.hourStart,
            costUsd: usd(period.costUsd),
            totalTokens: period.totalTokens,
            providers: periodProviders(period.byProvider),
          }))
        : merged.daily.map((period) => ({
            start: period.day,
            costUsd: usd(period.costUsd),
            totalTokens: period.totalTokens,
            providers: periodProviders(period.byProvider),
          })),
      pricing: { status: summary.pricing.status, fetchedAt: summary.pricing.fetchedAt },
    },
    notices: summary.sources.flatMap((source) =>
      source.message !== null && (source.status === "partial" || source.status === "failed")
        ? [`${sourceName(source.fingerprint)}: ${source.message}`]
        : [],
    ),
  };
};

export class UsageReport extends Context.Service<
  UsageReport,
  {
    readonly read: (input: {
      readonly days: SpendDays;
      readonly refresh: boolean;
    }) => Effect.Effect<OrchestratorMcpUsageResult>;
  }
>()("t3/usage/UsageReport") {}

const make = Effect.gen(function* () {
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
  const usage = yield* UsageService.UsageService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;

  const readSpend = Effect.fn("UsageReport.readSpend")(function* (input: {
    readonly days: SpendDays;
    readonly refresh: boolean;
    readonly now: DateTime.Utc;
  }) {
    const window = makeWindow(
      input.days,
      DateTime.toDateUtc(input.now),
      input.days === 1 ? "hour" : "day",
    );
    const summary = yield* usage.readSummary({
      ...window,
      ...(input.refresh ? { awaitRefresh: true } : {}),
    });
    const environment = yield* serverEnvironment.getDescriptor;
    return summarizeSpend(summary, environment, input.days);
  });

  const read = Effect.fn("UsageReport.read")(function* (input: {
    readonly days: SpendDays;
    readonly refresh: boolean;
  }) {
    const now = yield* DateTime.now;
    const [limits, spend] = yield* Effect.all(
      [
        Effect.gen(function* () {
          if (input.refresh) {
            yield* Effect.all(
              [providerRegistry.refresh(undefined, { fresh: true }), usageLimitSources.refresh],
              { concurrency: "unbounded", discard: true },
            );
          }
          const [providers, sources] = yield* Effect.all([
            providerRegistry.getProviders,
            usageLimitSources.current,
          ]);
          return {
            limits: summarizeLimits(providers, sources),
            notices: sources.flatMap((source) =>
              source.error === undefined ? [] : [`${source.label}: ${source.error}`],
            ),
          };
        }),
        readSpend({ ...input, now }).pipe(
          Effect.catch((error) =>
            Effect.succeed({ spend: null, notices: [`Spend: ${error.detail}`] }),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );
    return {
      createdAt: DateTime.formatIso(now),
      limits: limits.limits,
      spend: spend.spend,
      notices: [...limits.notices, ...spend.notices],
    };
  });

  return UsageReport.of({ read });
});

export const layer = Layer.effect(UsageReport, make);
