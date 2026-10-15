// Chart: the real No Fun chart blocks (blocks/charts/chart-bar, chart-area, chart-line on Recharts),
// framed by their shared shell: ChartFrame card, header with title, description, headline value and
// legend, then the plot.
import { ChartAreaPlot } from "@nofun/ui/chart-area";
import {
  ChartDescription,
  ChartFrame,
  ChartHeader,
  ChartHeading,
  ChartLegendList,
  ChartTitle,
  ChartValue,
  formatCompact,
  type ChartSeries,
} from "@nofun/ui/chart-area/chart-shell";
import { ChartBarPlot } from "@nofun/ui/chart-bar";
import { ChartLinePlot } from "@nofun/ui/chart-line";
import { formatNumberValue } from "@nofun/ui/number-value/format";
import { ArtifactEmpty, ArtifactLoading } from "./states.tsx";

type ChartDatum = Record<string, string | number | null>;

// Index 0 is ink, index 1 is the muted comparison, then chart-2..chart-5.
// chart-1 is too pale on a light ground, and status hues are reserved for status and up/down.
const SERIES_SLOTS = ["foreground", "muted", "chart-2", "chart-3", "chart-4", "chart-5"] as const;
const REMAPPED_TONES = new Set(["chart-1", "success", "warning", "error", "info", "danger"]);

function presentSeries(
  series: ChartSeries[],
  type: "bar" | "line" | "area",
): ChartSeries[] {
  return series.slice(0, SERIES_SLOTS.length).map((item, index) => {
    const slot = SERIES_SLOTS[index]!;
    const requested = item.color;
    const color =
      requested && !REMAPPED_TONES.has(requested) ? requested : (slot as ChartSeries["color"]);
    return {
      ...item,
      color,
      dashed: item.dashed ?? (type !== "bar" && index === 1),
    };
  });
}

export type ChartProps = {
  type?: "bar" | "line" | "area" | undefined;
  title?: string | undefined;
  description?: string | undefined;
  /** Headline number shown under the title, already formatted ("$48.2K"). */
  value?: string | undefined;
  data: ChartDatum[];
  xKey: string;
  series: ChartSeries[];
  stacked?: boolean | undefined;
  height?: number | undefined;
  valueFormat?: "decimal" | "compact" | "currency" | "percent" | undefined;
  currency?: string | undefined;
  /** Defaults to on when there is more than one series. */
  legend?: boolean | undefined;
  /** `plain` drops the card so the chart sits on the page. */
  variant?: "card" | "plain" | undefined;
  /** Shown when `data` is empty. */
  emptyText?: string | undefined;
  /** Static skeleton in place of the plot. */
  loading?: boolean | undefined;
  className?: string | undefined;
};

export function Chart({
  type = "bar",
  title,
  description,
  value,
  data,
  xKey,
  series,
  stacked,
  height,
  valueFormat = "compact",
  currency,
  legend,
  variant = "card",
  emptyText = "Numbers appear here once there is something to plot.",
  loading = false,
  className,
}: ChartProps) {
  const plotted = presentSeries(series, type);
  const showLegend = (legend ?? plotted.length > 1) && !loading && data.length > 0;
  const formatter =
    valueFormat === "compact"
      ? formatCompact
      : (n: number) =>
          formatNumberValue(n, {
            format: valueFormat,
            currency,
            notation: valueFormat === "currency" ? "compact" : undefined,
            maximumFractionDigits: valueFormat === "percent" ? 0 : 1,
          });
  const hasHeader = Boolean(title || description || value || showLegend);
  const plot = {
    data,
    xKey,
    series: plotted,
    height: height ?? 240,
    yFormatter: formatter,
    label: title,
  };
  return (
    <ChartFrame variant={variant} className={className}>
      {hasHeader ? (
        <ChartHeader>
          <ChartHeading className="min-w-0 flex-1">
            {title ? <ChartTitle className="whitespace-normal text-pretty">{title}</ChartTitle> : null}
            {description ? <ChartDescription>{description}</ChartDescription> : null}
            {value ? <ChartValue className="mt-1">{value}</ChartValue> : null}
          </ChartHeading>
          {showLegend ? <ChartLegendList series={plotted} className="max-w-full" /> : null}
        </ChartHeader>
      ) : null}
      {loading ? (
        <div className="px-(--card-spacing)">
          <ArtifactLoading label={title ? `Loading ${title}` : "Loading chart"} lines={4} />
        </div>
      ) : data.length === 0 || plotted.length === 0 ? (
        <div className="px-(--card-spacing)">
          <ArtifactEmpty title="No data yet" detail={emptyText} />
        </div>
      ) : type === "line" ? (
        <ChartLinePlot {...plot} />
      ) : type === "area" ? (
        <ChartAreaPlot {...plot} stacked={stacked} />
      ) : (
        <ChartBarPlot {...plot} stacked={stacked} />
      )}
    </ChartFrame>
  );
}
