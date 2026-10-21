import {
  OrchestratorMcpUsageLimitsResult,
  type OrchestratorMcpUsageWindow,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/usageLimits";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import { printJson, reportThreadErrors, withThreadTools } from "./thread.ts";

type Reading = Pick<
  OrchestratorMcpUsageLimitsResult["providers"][number],
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
  return `  ${window.label.padEnd(16)} ${String(window.remainingPercent).padStart(3)}% left${reset}`;
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
    header,
    ...(reading.unavailable === null
      ? reading.windows.map((window) => formatWindow(window, now))
      : [`  ${reading.unavailable.message}`]),
  ];
};

export const formatUsageLimits = (report: OrchestratorMcpUsageLimitsResult, now: number) =>
  [
    ...report.providers.flatMap((provider) =>
      formatReading(
        `${provider.displayName ?? provider.driverKind} [${provider.providerInstanceId}]`,
        provider,
        now,
      ),
    ),
    ...report.pooledAccounts.flatMap((account) =>
      formatReading(
        `${account.sourceLabel} · ${account.accountId} [${account.driverKind}]`,
        account,
        now,
      ),
    ),
    ...report.notices,
  ].join("\n");

export const usageCommand = Command.make("usage", {
  ...projectLocationFlags,
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
    "Show each provider's subscription usage limits and when they reset, from the running server.",
  ),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.usage")(function* (tools) {
        const report = yield* tools.call(
          "provider_usage_limits",
          { refresh: flags.refresh },
          OrchestratorMcpUsageLimitsResult,
        );
        if (flags.json) {
          return yield* printJson(report);
        }
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        yield* Console.log(formatUsageLimits(report, now) || "No providers are enabled.");
      }),
      { label: "t3 usage cli", name: "t3-usage-cli" },
    ).pipe(reportThreadErrors),
  ),
);
