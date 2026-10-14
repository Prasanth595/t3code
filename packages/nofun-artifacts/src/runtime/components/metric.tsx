// Metric composes the real No Fun KPI card (blocks/charts/kpi), TrendChip and Sparkline blocks.
// Status is the Kobra Badge with the tone mapping the timeline block uses (blocks/data/timeline).
import { Badge } from "@nofun/kobra/badge";
import { Sparkline } from "@nofun/ui/sparkline";
import { Kpi, KpiFooter, KpiHeader, KpiLabel, KpiMain, KpiTrend, KpiValue } from "@nofun/ui/kpi";
import { cn } from "@nofun/source/lib/utils";
import type { NumberValueFormat } from "@nofun/ui/number-value/format";
import { ArtifactLoading } from "./states.tsx";

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger" | "primary";

const BADGE_VARIANT = {
  neutral: "neutral",
  info: "blue",
  success: "green",
  warning: "amber",
  danger: "destructive",
  primary: "default",
} as const;

export type StatusProps = {
  label: string;
  tone?: StatusTone | undefined;
  /** Muted text after the badge: a time, an owner, a count. */
  detail?: string | undefined;
  size?: "sm" | "default" | undefined;
  className?: string | undefined;
};

export function Status({
  label,
  tone = "neutral",
  detail,
  size = "default",
  className,
}: StatusProps) {
  return (
    <span
      data-slot="status"
      className={cn("inline-flex max-w-full min-w-0 flex-wrap items-center gap-2", className)}
    >
      <Badge
        variant={BADGE_VARIANT[tone]}
        size={size}
        className="h-auto max-w-full min-h-6 shrink whitespace-normal text-start"
      >
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
        {label}
      </Badge>
      {detail ? (
        <span className="min-w-0 text-xs wrap-break-word text-muted-foreground">{detail}</span>
      ) : null}
    </span>
  );
}

export type MetricProps = {
  label: string;
  /** `null` shows a muted dash: the reading is missing, not zero. With `format: "percent"`, 0.25 is 25%. */
  value: number | null;
  format?: Exclude<NumberValueFormat, "unit"> | undefined;
  currency?: string | undefined;
  /** Short suffix after the number, such as "ms" or "users". */
  unit?: string | undefined;
  maximumFractionDigits?: number | undefined;
  /** Change in percentage points: 12.4 renders +12.4%. */
  change?: number | null | undefined;
  /** A fall is good news (churn, refunds, latency): swaps the trend hues. */
  invert?: boolean | undefined;
  /** Recent values, oldest first, drawn as a sparkline. */
  trend?: number[] | undefined;
  /** Footer line, e.g. "vs last week" or the data source. */
  footer?: string | undefined;
  /** Static skeleton in place of the reading. The label stays so the card is identifiable. */
  loading?: boolean | undefined;
  status?: { label: string; tone?: StatusTone | undefined } | undefined;
  className?: string | undefined;
};

export function Metric({
  label,
  value,
  format,
  currency,
  unit,
  maximumFractionDigits,
  change,
  invert,
  trend,
  footer,
  loading = false,
  status,
  className,
}: MetricProps) {
  return (
    <Kpi className={className}>
      <KpiHeader className="h-auto min-h-6 items-start">
        <KpiLabel className="whitespace-normal overflow-visible text-clip">{label}</KpiLabel>
        {status && !loading ? (
          <span className="ms-auto max-w-full">
            <Status label={status.label} tone={status.tone} size="sm" />
          </span>
        ) : null}
      </KpiHeader>
      {loading ? (
        <div className="px-(--card-spacing) pb-1">
          <ArtifactLoading label={`Loading ${label}`} lines={2} />
        </div>
      ) : (
        <KpiMain>
        <KpiValue
          value={value}
          format={format}
          currency={currency}
          // A whole-number amount reads "$48,210", not "$48,210.00".
          maximumFractionDigits={
            maximumFractionDigits ??
            (format === "currency" && value !== null && Number.isInteger(value) ? 0 : undefined)
          }
          suffix={unit}
        />
        <KpiTrend value={change ?? null} invert={invert ?? false} size="sm" />
        </KpiMain>
      )}
      {!loading && trend && trend.length > 1 ? (
        <div className="px-(--card-spacing)">
          <Sparkline data={trend} tone={trendTone(trend, invert)} label={`${label} trend`} />
        </div>
      ) : null}
      {footer ? (
        <KpiFooter className="h-auto min-h-10 whitespace-normal wrap-break-word">{footer}</KpiFooter>
      ) : null}
    </Kpi>
  );
}

/** The sparkline reads green when the series moved the good way (down, for an inverted metric). */
function trendTone(trend: number[], invert: boolean | undefined): "success" | "error" | "neutral" {
  if (trend.length < 2) return "neutral";
  const up = trend[trend.length - 1]! >= trend[0]!;
  return up !== Boolean(invert) ? "success" : "error";
}
