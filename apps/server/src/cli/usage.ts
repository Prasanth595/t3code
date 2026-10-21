import {
  OrchestratorMcpUsageResult,
  type OrchestratorMcpUsageLimits,
  type OrchestratorMcpUsageSpend,
  type OrchestratorMcpUsageWindow,
} from "@t3tools/contracts";
import { formatCount, formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { formatDuration } from "@t3tools/shared/usageLimits";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import { printJson, reportThreadErrors, withThreadTools } from "./thread.ts";

type Reading = Pick<
  OrchestratorMcpUsageLimits["providers"][number],
  "email" | "plan" | "checkedAt" | "windows" | "unavailable"
>;

const formatWindow = (window: OrchestratorMcpUsageWindow, now: number) => {
  const resetsAt = window.resetsAt === null ? null : Date.parse(window.resetsAt);
  const reset =
    resetsAt === null || !Number.isFinite(resetsAt)
      ? ""
      : resetsAt <= now
        ? " · resets now"
        : ` · resets in ${formatDuration(resetsAt - now)}`;
  return `    ${window.label.padEnd(16)} ${String(window.remainingPercent).padStart(3)}% left${reset}`;
};

const formatReading = (title: string, reading: Reading, now: number) => {
  const checkedAt = reading.checkedAt === null ? null : Date.parse(reading.checkedAt);
  const header = [
    title,
    reading.plan,
    reading.email,
    checkedAt === null ? null : `read ${formatDuration(now - checkedAt)} ago`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return [
    `  ${header}`,
    ...(reading.unavailable === null
      ? reading.windows.map((window) => formatWindow(window, now))
      : [`    ${reading.unavailable.message}`]),
  ];
};

const formatLimits = (limits: OrchestratorMcpUsageLimits, now: number) => {
  const lines = [
    ...limits.providers.flatMap((provider) =>
      formatReading(
        `${provider.displayName ?? provider.driverKind} [${provider.providerInstanceId}]`,
        provider,
        now,
      ),
    ),
    ...limits.pooledAccounts.flatMap((account) =>
      formatReading(
        `${account.sourceLabel} · ${account.accountId} [${account.driverKind}]`,
        account,
        now,
      ),
    ),
  ];
  return ["Limits", ...(lines.length === 0 ? ["  No providers are enabled."] : lines)];
};

const amount = (costUsd: number | null, totalTokens: number) =>
  `${(costUsd === null ? "unpriced" : formatUsd(costUsd)).padStart(11)}  ${formatTokens(totalTokens).padStart(6)} tokens`;

const joinNonZero = (parts: ReadonlyArray<readonly [string, number]>) =>
  parts
    .filter(([, value]) => value > 0)
    .map(([label, value]) => `${label} ${formatUsd(value)}`)
    .join(" · ");

const formatSpend = (spend: OrchestratorMcpUsageSpend) => {
  const { window, tokens } = spend;
  const range =
    window.days === 1
      ? "past 24 hours"
      : `${window.days} days, ${window.sinceDay} to ${window.untilDay}`;
  const width = Math.max(
    0,
    ...[
      ...spend.providers.map((provider) => provider.provider),
      ...spend.models.map((model) => model.model),
      ...spend.periods.map((period) => period.start),
    ].map((label) => label.length),
  );
  const byCategory = joinNonZero([
    ["input", spend.costByCategoryUsd.input],
    ["cache read", spend.costByCategoryUsd.cacheRead],
    ["cache write", spend.costByCategoryUsd.cacheWrite],
    ["output", spend.costByCategoryUsd.output],
    ["unsplit", spend.costByCategoryUsd.unsplit],
  ]);
  const bySpeed = joinNonZero([
    ["fast", spend.costBySpeedUsd.fast],
    ["ultrafast", spend.costBySpeedUsd.ultrafast],
    ["premium", spend.costBySpeedUsd.premium],
  ]);
  return [
    `Spend · ${range} (${window.timeZone}) · API estimate`,
    `  ${formatUsd(spend.costUsd)} · ${formatTokens(tokens.total)} tokens · ${formatCount(spend.sessions)} sessions${
      spend.cacheSavingsUsd > 0 ? ` · cache saved ${formatUsd(spend.cacheSavingsUsd)}` : ""
    }${spend.unpricedShare > 0 ? ` · ${formatPercent(spend.unpricedShare)} unpriced` : ""}`,
    `  Tokens: input ${formatTokens(tokens.uncachedInput)} · cache read ${formatTokens(tokens.cachedInput)} · cache write ${formatTokens(tokens.cacheCreation)} · output ${formatTokens(tokens.output)} (reasoning ${formatTokens(tokens.reasoning)})`,
    ...(byCategory === "" ? [] : [`  Cost: ${byCategory}`]),
    ...(bySpeed === "" ? [] : [`  Speed: ${bySpeed}`]),
    "  By provider",
    ...spend.providers.map(
      (provider) =>
        `    ${provider.provider.padEnd(width)}  ${amount(provider.costUsd, provider.totalTokens)}  ${formatCount(provider.sessions)} sessions`,
    ),
    "  By model",
    ...spend.models.map(
      (model) => `    ${model.model.padEnd(width)}  ${amount(model.costUsd, model.tokens.total)}`,
    ),
    window.days === 1 ? "  By hour" : "  By day",
    ...spend.periods.map(
      (period) =>
        `    ${period.start.padEnd(width)}  ${amount(period.costUsd, period.totalTokens)}`,
    ),
  ];
};

export const formatUsage = (report: OrchestratorMcpUsageResult, now: number) =>
  [
    ...formatLimits(report.limits, now),
    ...(report.spend === null ? [] : formatSpend(report.spend)),
    ...(report.notices.length === 0
      ? []
      : ["Notices", ...report.notices.map((notice) => `  ${notice}`)]),
  ].join("\n");

export const usageCommand = Command.make("usage", {
  ...projectLocationFlags,
  days: Flag.ChoiceWithValue("days", [
    ["1", 1],
    ["7", 7],
    ["30", 30],
    ["90", 90],
  ] as const).pipe(
    Flag.withDescription("Spend window in days, as on the Usage tab. 1 shows the past 24 hours."),
    Flag.withDefault(30),
  ),
  refresh: Flag.Boolean("refresh").pipe(
    Flag.withDescription("Re-read every provider before printing. Slower."),
    Flag.withDefault(false),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print JSON instead of text."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Show what the Usage tab shows: each provider's subscription limits and reset times, and token and dollar spend.",
  ),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.usage")(function* (tools) {
        const report = yield* tools.call(
          "t3_usage",
          { days: flags.days, refresh: flags.refresh },
          OrchestratorMcpUsageResult,
        );
        if (flags.json) {
          return yield* printJson(report);
        }
        yield* Console.log(formatUsage(report, DateTime.toEpochMillis(yield* DateTime.now)));
      }),
      { label: "t3 usage cli", name: "t3-usage-cli" },
    ).pipe(reportThreadErrors),
  ),
);
