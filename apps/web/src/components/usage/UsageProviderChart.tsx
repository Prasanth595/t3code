import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import type { UsageProviderKind } from "@t3tools/contracts";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { DailyTotals, HourlyTotals } from "@t3tools/shared/usageMerge";
import {
  formatDayShort,
  formatHourShort,
  formatRelativeHourShort,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import { cn } from "~/lib/utils";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";
import { observeResize } from "~/lib/observeResize";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;
const NONE_LOADING: ReadonlySet<UsageProviderKind> = new Set();

export type UsageChartMetric = "tokens" | "cost";

interface UsageProviderChartProps {
  readonly providers: readonly UsageProviderKind[];
  /** Providers whose figures are still coming in: their lines are muted. */
  readonly loadingProviders?: ReadonlySet<UsageProviderKind>;
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly hours: readonly string[];
  readonly hourly: readonly HourlyTotals[];
  readonly metric: UsageChartMetric;
  readonly referenceTime: string | undefined;
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
}

export interface UsageChartColumn {
  readonly bands: readonly { readonly id: string; readonly value: number }[];
  readonly total: number;
}

interface UsageChartSeries {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly provider?: UsageProviderKind;
  readonly loading?: boolean;
  readonly strokeDasharray?: string | undefined;
}

interface UsageTrendChartProps {
  readonly periods: readonly string[];
  readonly columns: readonly UsageChartColumn[];
  readonly chartSeries: readonly UsageChartSeries[];
  readonly metric: UsageChartMetric;
  readonly referenceTime: string | undefined;
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
  readonly breakdownLabel: string;
}

/** One day's per-provider values, shared by the paths and the hover readout. */
export interface DayColumn {
  readonly bands: readonly {
    readonly provider: UsageProviderKind;
    readonly value: number;
  }[];
  readonly total: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

function valueFor(
  totals: DailyTotals | HourlyTotals | undefined,
  provider: UsageProviderKind,
  metric: UsageChartMetric,
): number {
  const entry = totals?.byProvider.get(provider);
  if (entry === undefined) return 0;
  return metric === "tokens" ? entry.totalTokens : entry.costUsd;
}

export function buildPeriodColumns(
  periods: readonly string[],
  byPeriod: ReadonlyMap<string, DailyTotals | HourlyTotals>,
  metric: UsageChartMetric,
): readonly DayColumn[] {
  return periods.map((period) => {
    const entry = byPeriod.get(period);
    const bands = PROVIDER_ORDER.map((provider) => ({
      provider,
      value: valueFor(entry, provider, metric),
    }));
    return { bands, total: bands.reduce((sum, band) => sum + band.value, 0) };
  });
}

/** Shape-preserving cubic tangents that cannot overshoot spiky usage data. */
function monotoneTangents(points: readonly Point[]): readonly number[] {
  const count = points.length;
  if (count < 2) return [0];

  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const dx = (points[index + 1]?.x ?? 0) - (points[index]?.x ?? 0);
    const dy = (points[index + 1]?.y ?? 0) - (points[index]?.y ?? 0);
    slopes.push(dx === 0 ? 0 : dy / dx);
  }

  const tangents: number[] = Array.from({ length: count }, () => 0);
  tangents[0] = slopes[0] ?? 0;
  tangents[count - 1] = slopes[count - 2] ?? 0;
  for (let index = 1; index < count - 1; index += 1) {
    const previous = slopes[index - 1] ?? 0;
    const next = slopes[index] ?? 0;
    tangents[index] = previous * next <= 0 ? 0 : (previous + next) / 2;
  }

  for (let index = 0; index < count - 1; index += 1) {
    const slope = slopes[index] ?? 0;
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const a = (tangents[index] ?? 0) / slope;
    const b = (tangents[index + 1] ?? 0) / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[index] = scale * a * slope;
      tangents[index + 1] = scale * b * slope;
    }
  }

  return tangents;
}

interface CurveSegment {
  readonly from: Point;
  readonly c1: Point;
  readonly c2: Point;
  readonly to: Point;
}

function smoothCurve(points: readonly Point[]): readonly CurveSegment[] {
  if (points.length < 2) return [];
  const tangents = monotoneTangents(points);
  const segments: CurveSegment[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (from === undefined || to === undefined) continue;
    const dx = to.x - from.x;
    segments.push({
      from,
      c1: { x: from.x + dx / 3, y: from.y + ((tangents[index] ?? 0) * dx) / 3 },
      c2: { x: to.x - dx / 3, y: to.y - ((tangents[index + 1] ?? 0) * dx) / 3 },
      to,
    });
  }
  return segments;
}

function curvePath(segments: readonly CurveSegment[]): string {
  const first = segments[0];
  if (first === undefined) return "";
  let path = `M${first.from.x.toFixed(2)},${first.from.y.toFixed(2)}`;
  for (const segment of segments) {
    path += ` C${segment.c1.x.toFixed(2)},${segment.c1.y.toFixed(2)} ${segment.c2.x.toFixed(2)},${segment.c2.y.toFixed(2)} ${segment.to.x.toFixed(2)},${segment.to.y.toFixed(2)}`;
  }
  return path;
}

function areaPath(line: string) {
  return line === "" ? "" : `${line} L${VIEW_WIDTH},${VIEW_HEIGHT} L0,${VIEW_HEIGHT} Z`;
}

/**
 * Builds a scale whose maximum is a readable 1/2/5 x 10^n step at or above the
 * peak.
 *
 * Rounding the maximum *up* is the point: stopping at the last step below the
 * peak leaves the tallest day drawn past the top of the plot, where it is
 * clipped.
 */
export function niceScale(peak: number, count: number): { max: number; ticks: readonly number[] } {
  if (peak <= 0) return { max: 0, ticks: [0] };

  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;

  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

const PLACEHOLDER_TICKS = Array.from({ length: TICK_COUNT + 1 }, (_, index) => index);

/**
 * Scales to the largest single provider-period. With nothing to show yet while
 * providers load, unlabeled placeholder gridlines hold their usual spacing so
 * nothing shifts on arrival.
 */
export function chartScale(
  columns: readonly { readonly bands: readonly { readonly value: number }[] }[],
  loadingProviders: ReadonlySet<string>,
) {
  // Not the sum: layered series each measure from zero, so a combined peak
  // would leave the plot permanently half empty.
  const peak = columns.reduce(
    (max, column) => column.bands.reduce((inner, band) => Math.max(inner, band.value), max),
    0,
  );
  return peak === 0 && loadingProviders.size > 0
    ? { max: TICK_COUNT, ticks: PLACEHOLDER_TICKS, labeled: false }
    : { ...niceScale(peak, TICK_COUNT), labeled: true };
}

// Leave room above the top gridline so the constant-width stroke is not
// clipped when a series reaches the peak.
function valueToY(value: number, max: number) {
  return max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);
}

/** Series paths in paint order, heaviest first, for both providers and efforts. */
function buildChart(
  periods: readonly string[],
  columns: readonly UsageChartColumn[],
  chartSeries: readonly UsageChartSeries[],
) {
  const loading = new Set(
    chartSeries.filter((series) => series.loading).map((series) => series.id),
  );
  const scale = chartScale(columns, loading);
  const stepX = periods.length < 2 ? 0 : VIEW_WIDTH / (periods.length - 1);
  const paths = chartSeries.map((series) => {
    const values = columns.map(
      (column) => column.bands.find((band) => band.id === series.id)?.value ?? 0,
    );
    const line = curvePath(
      smoothCurve(
        values.map((value, index) => ({
          x: index * stepX,
          y: valueToY(value, scale.max),
        })),
      ),
    );
    return {
      series,
      total: values.reduce((sum, value) => sum + value, 0),
      line,
      area: areaPath(line),
    };
  });
  return { scale, stepX, paths: paths.toSorted((a, b) => b.total - a.total) };
}

export function UsageProviderChart({
  providers,
  loadingProviders = NONE_LOADING,
  days,
  daily,
  hours,
  hourly,
  metric,
  referenceTime,
  resolution,
  timeZone,
}: UsageProviderChartProps) {
  const periods = resolution === "hour" ? hours : days;
  const byPeriod = useMemo(
    () =>
      resolution === "hour"
        ? new Map(hourly.map((entry) => [entry.hourStart, entry]))
        : new Map(daily.map((entry) => [entry.day, entry])),
    [daily, hourly, resolution],
  );
  const columns = useMemo(
    () =>
      buildPeriodColumns(periods, byPeriod, metric).map((column) => ({
        total: column.total,
        bands: column.bands.map((band) => ({ id: band.provider, value: band.value })),
      })),
    [periods, byPeriod, metric],
  );
  const chartSeries = useMemo(
    () =>
      providers.map((provider) => ({
        id: provider,
        provider,
        label: PROVIDER_PRESENTATION[provider].label,
        color: PROVIDER_PRESENTATION[provider].color,
        loading: loadingProviders.has(provider),
      })),
    [providers, loadingProviders],
  );
  return (
    <UsageTrendChart
      periods={periods}
      columns={columns}
      chartSeries={chartSeries}
      metric={metric}
      referenceTime={referenceTime}
      resolution={resolution}
      timeZone={timeZone}
      breakdownLabel="provider"
    />
  );
}

export function UsageTrendChart({
  periods,
  columns,
  chartSeries,
  metric,
  referenceTime,
  resolution,
  timeZone,
  breakdownLabel,
}: UsageTrendChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverPositionRef = useRef<{ x: number; y: number } | null>(null);

  const { scale, paths, stepX } = useMemo(
    () => buildChart(periods, columns, chartSeries),
    [periods, columns, chartSeries],
  );
  const toY = (value: number) => valueToY(value, scale.max);
  const seriesClassName = (loading: boolean | undefined) =>
    cn("transition-opacity", loading && "opacity-40 delay-150");

  const format = metric === "tokens" ? formatTokens : formatUsd;

  const positionTooltip = useCallback(() => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    const hoverPosition = hoverPositionRef.current;
    if (plot === null || tooltip === null || hoverPosition === null) return;

    const gap = 12;
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const plotWidth = plot.clientWidth;
    const plotHeight = plot.clientHeight;
    const preferredLeft =
      hoverPosition.x + gap + tooltipWidth <= plotWidth
        ? hoverPosition.x + gap
        : hoverPosition.x - gap - tooltipWidth;
    const preferredTop =
      hoverPosition.y + gap + tooltipHeight <= plotHeight
        ? hoverPosition.y + gap
        : hoverPosition.y - gap - tooltipHeight;
    const left = Math.min(Math.max(0, preferredLeft), Math.max(0, plotWidth - tooltipWidth));
    const top = Math.min(Math.max(0, preferredTop), Math.max(0, plotHeight - tooltipHeight));
    plot.style.setProperty("--usage-tooltip-left", `${left}px`);
    plot.style.setProperty("--usage-tooltip-top", `${top}px`);
  }, []);

  useLayoutEffect(() => {
    if (hoverIndex === null) return;
    positionTooltip();

    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (plot === null || tooltip === null) return;

    return observeResize([plot, tooltip], positionTooltip);
  }, [hoverIndex, positionTooltip]);

  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const plot = plotRef.current;
      if (plot === null || periods.length === 0) return;
      const bounds = plot.getBoundingClientRect();
      if (bounds.width === 0) return;
      const localX = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
      const localY = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
      const fraction = localX / bounds.width;
      const index = Math.round(fraction * (periods.length - 1));
      hoverPositionRef.current = { x: localX, y: localY };
      positionTooltip();
      setHoverIndex(Math.min(periods.length - 1, Math.max(0, index)));
    },
    [periods.length, positionTooltip],
  );

  const hoveredPeriod = hoverIndex === null ? undefined : periods[hoverIndex];
  const hoveredColumn = hoverIndex === null ? undefined : columns[hoverIndex];
  const partial = chartSeries.some((series) => series.loading);
  const formatPeriod = (period: string) =>
    resolution === "hour" ? formatHourShort(period, timeZone) : formatDayShort(period);
  const formatTooltipPeriod = (period: string) =>
    resolution === "hour" && referenceTime !== undefined
      ? formatRelativeHourShort(period, referenceTime, timeZone)
      : formatPeriod(period);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        {/* Axis labels sit outside the plot so they stay aligned to gridlines. */}
        <div className="relative h-56 w-14 shrink-0">
          {scale.labeled
            ? scale.ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute right-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
                  style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
                >
                  {tick === 0 ? "0" : format(tick)}
                </span>
              ))
            : null}
        </div>

        <div
          ref={plotRef}
          className="relative h-56 flex-1"
          onMouseMove={handleMove}
          onMouseLeave={() => {
            hoverPositionRef.current = null;
            setHoverIndex(null);
          }}
        >
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${resolution === "hour" ? "Hourly" : "Daily"} ${metric === "tokens" ? "processed tokens" : "cost"} by ${breakdownLabel}`}
          >
            {scale.ticks.map((tick) => {
              const y = toY(tick);
              return (
                <line
                  key={tick}
                  x1={0}
                  x2={VIEW_WIDTH}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth={1}
                  className="text-border"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}

            {/* Fills first, then every stroke, so no series covers another's line. */}
            {paths.map(({ series, area }) => (
              <path
                key={series.id}
                d={area}
                className={seriesClassName(series.loading)}
                fill={series.color}
                fillOpacity={0.12}
              />
            ))}
            {paths.map(({ series, line }) => (
              <path
                key={series.id}
                d={line}
                className={seriesClassName(series.loading)}
                fill="none"
                stroke={series.color}
                strokeDasharray={series.strokeDasharray}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {hoverIndex === null ? null : (
              <line
                x1={hoverIndex * stepX}
                x2={hoverIndex * stepX}
                y1={PLOT_TOP}
                y2={VIEW_HEIGHT}
                stroke="currentColor"
                strokeWidth={1}
                className="text-muted-foreground"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          {hoveredPeriod === undefined ? null : (
            <div
              ref={tooltipRef}
              role="tooltip"
              className="surface-glass pointer-events-none absolute z-10 min-w-36 max-w-full rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
              style={{
                left: "var(--usage-tooltip-left, 0px)",
                top: "var(--usage-tooltip-top, 0px)",
              }}
            >
              <div className="mb-1 text-muted-foreground">{formatTooltipPeriod(hoveredPeriod)}</div>
              {chartSeries.map((series) => (
                <div
                  key={series.id}
                  className={cn(
                    "flex items-center justify-between gap-3",
                    series.loading && "opacity-40",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    {series.provider === undefined ? (
                      <span
                        aria-hidden
                        className="size-2 rounded-xs"
                        style={{ backgroundColor: series.color }}
                      />
                    ) : (
                      <ProviderInstanceIcon
                        driverKind={PROVIDER_PRESENTATION[series.provider].driverKind}
                        displayName={series.label}
                        iconClassName="size-3"
                      />
                    )}
                    {series.label}
                  </span>
                  <span className="text-foreground tabular-nums">
                    {format(hoveredColumn?.bands.find((band) => band.id === series.id)?.value ?? 0)}
                  </span>
                </div>
              ))}
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
                <span className="text-muted-foreground">Total</span>
                <span
                  className={cn(
                    "tabular-nums",
                    partial ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {format(hoveredColumn?.total ?? 0)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-between pl-16 text-3xs text-muted-foreground uppercase">
        <span>{periods[0] === undefined ? "" : formatPeriod(periods[0])}</span>
        <span>
          {periods[Math.floor(periods.length / 2)] === undefined
            ? ""
            : formatPeriod(periods[Math.floor(periods.length / 2)] ?? "")}
        </span>
        <span>
          {periods[periods.length - 1] === undefined
            ? ""
            : formatPeriod(periods[periods.length - 1] ?? "")}
        </span>
      </div>
    </div>
  );
}
