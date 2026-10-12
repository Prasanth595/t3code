import type { DailyTotals, HourlyTotals, ModelTotals } from "@t3tools/shared/usageMerge";
import { isModelCostUnknown } from "@t3tools/shared/usageMerge";
import { useMemo, useState } from "react";

import { Toggle, ToggleGroup } from "../ui/toggle-group";
import type { UsageChartWindow } from "./UsageModelDialog";
import {
  UsageProviderChart,
  UsageTrendChart,
  type UsageChartColumn,
  type UsageChartMetric,
} from "./UsageProviderChart";
import { reasoningEffortRows } from "./usageBreakdown";

/** Missing periods are zero; history without effort metadata stays unknown. */
export function buildReasoningPeriodColumns(
  periods: readonly string[],
  byPeriod: ReadonlyMap<string, DailyTotals | HourlyTotals>,
  efforts: readonly string[],
  metric: UsageChartMetric,
): readonly UsageChartColumn[] {
  return periods.map((period) => {
    const totals = byPeriod.get(period);
    const bands = efforts.map((effort) => {
      const entry =
        totals?.byReasoningEffort?.get(effort) ??
        (effort === "unknown" && totals?.byReasoningEffort === undefined ? totals : undefined);
      return {
        id: effort,
        value: (metric === "tokens" ? entry?.totalTokens : entry?.costUsd) ?? 0,
      };
    });
    return { bands, total: bands.reduce((sum, band) => sum + band.value, 0) };
  });
}

export function UsageModelTrend({
  model,
  daily,
  hourly,
  metric,
  chartWindow,
}: {
  readonly model: ModelTotals;
  readonly daily: readonly DailyTotals[];
  readonly hourly: readonly HourlyTotals[];
  readonly metric: UsageChartMetric;
  readonly chartWindow: UsageChartWindow;
}) {
  const [view, setView] = useState<"all" | "effort">("all");
  // Unpriced cost is unknown, so the trend still shows the model's tokens.
  const chartMetric = isModelCostUnknown(model) ? "tokens" : metric;
  const providers = useMemo(() => [model.provider], [model.provider]);
  const chartSeries = useMemo(
    () =>
      reasoningEffortRows(model).map(({ effort, label, color, strokeDasharray }) => ({
        id: effort,
        label,
        color,
        strokeDasharray,
      })),
    [model],
  );
  const periods = chartWindow.resolution === "hour" ? chartWindow.hours : chartWindow.days;
  const columns = useMemo(() => {
    const byPeriod =
      chartWindow.resolution === "hour"
        ? new Map(hourly.map((entry) => [entry.hourStart, entry]))
        : new Map(daily.map((entry) => [entry.day, entry]));
    return buildReasoningPeriodColumns(
      periods,
      byPeriod,
      chartSeries.map((entry) => entry.id),
      chartMetric,
    );
  }, [chartMetric, chartSeries, chartWindow.resolution, daily, hourly, periods]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">
          {chartMetric === "cost" ? "Cost" : "Tokens"} over time
        </span>
        <ToggleGroup
          aria-label="Model chart breakdown"
          value={[view]}
          onValueChange={(next) => {
            if (next[0] === "all" || next[0] === "effort") setView(next[0]);
          }}
        >
          <Toggle value="all">All usage</Toggle>
          <Toggle value="effort">By effort</Toggle>
        </ToggleGroup>
      </div>
      {view === "effort" ? (
        <UsageTrendChart
          key="effort"
          {...chartWindow}
          periods={periods}
          columns={columns}
          chartSeries={chartSeries}
          breakdownLabel="reasoning effort"
          metric={chartMetric}
        />
      ) : (
        <UsageProviderChart
          key="all"
          {...chartWindow}
          providers={providers}
          daily={daily}
          hourly={hourly}
          metric={chartMetric}
        />
      )}
      {view === "effort" ? (
        <div
          aria-label="Reasoning effort legend"
          className="flex flex-wrap gap-x-4 gap-y-2 pl-16 text-xs text-muted-foreground"
        >
          {chartSeries.map(({ id, label, color }) => (
            <span key={id} className="flex items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-xs" style={{ backgroundColor: color }} />
              {label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
