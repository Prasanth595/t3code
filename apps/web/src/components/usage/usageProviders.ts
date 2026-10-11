import type { UsageProviderKind } from "@t3tools/contracts";

import { ProviderDriverKind } from "@t3tools/contracts";
import type { DailyTotals, HourlyTotals } from "@t3tools/shared/usageMerge";
import {
  MODEL_FAMILY_LABEL,
  MODEL_FAMILY_ORDER,
  type ModelFamily,
} from "@t3tools/shared/usageModelFamily";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly driverKind: ProviderDriverKind;
};

/**
 * Exhaustive presentation for providers supported by the usage contract.
 * Declaration order is reused by every chart and table, so adding a provider
 * only requires its contract support and one entry here.
 */
export const PROVIDER_PRESENTATION = {
  codex: {
    label: "Codex",
    color: "var(--contrast-foreground)",
    driverKind: ProviderDriverKind.make("codex"),
  },
  claude: {
    label: "Claude Code",
    color: "#d97757",
    driverKind: ProviderDriverKind.make("claudeAgent"),
  },
  grok: {
    label: "Grok Build",
    // Contrast-aware neutral between the Codex series and muted chart chrome.
    color: "color-mix(in oklab, var(--contrast-foreground) 72%, var(--background))",
    driverKind: ProviderDriverKind.make("grok"),
  },
  cursor: { label: "Cursor", color: "#8b8b8b", driverKind: ProviderDriverKind.make("cursor") },
  opencode: {
    label: "OpenCode",
    color: "#5b9bbd",
    driverKind: ProviderDriverKind.make("opencode"),
  },
  antigravity: {
    label: "Antigravity",
    color: "#8c7bd1",
    driverKind: ProviderDriverKind.make("antigravity"),
  },
  pi: {
    label: "Pi",
    color: "#4d9f8a",
    driverKind: ProviderDriverKind.make("pi"),
  },
} satisfies Record<UsageProviderKind, UsageProviderPresentation>;

/** Stable provider reading order across charts, summaries, tables, and hover rows. */
export const PROVIDER_ORDER = Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[];

/** Providers with real activity, independent of the metric currently displayed. */
export function providersWithUsage(
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
): readonly UsageProviderKind[] {
  const active = new Set(
    totals
      .filter((entry) => entry.totalTokens > 0 || entry.costUsd > 0)
      .map((entry) => entry.provider),
  );
  return PROVIDER_ORDER.filter((provider) => active.has(provider));
}

/** What the summary rows, the chart and the period table are keyed by. */
export type UsageGroupBy = "harness" | "family";

/** Families are a color only. Vendors behind a built-in harness reuse its color. */
const FAMILY_COLOR = {
  anthropic: PROVIDER_PRESENTATION.claude.color,
  openai: PROVIDER_PRESENTATION.codex.color,
  google: PROVIDER_PRESENTATION.antigravity.color,
  xai: PROVIDER_PRESENTATION.grok.color,
  cursor: PROVIDER_PRESENTATION.cursor.color,
  meta: "#0ea5e9",
  moonshot: "#ec4899",
  zai: "#a855f7",
  deepseek: "#6366f1",
  xiaomi: "#65a30d",
  alibaba: "#14b8a6",
  mistral: "#f59e0b",
  unknown: "color-mix(in oklab, var(--foreground) 35%, var(--background))",
} satisfies Record<ModelFamily, string>;

export type UsageSeriesKey = UsageProviderKind | ModelFamily;

/** One summary row, chart line and table column of the current grouping. */
export interface UsageSeries {
  readonly key: UsageSeriesKey;
  readonly label: string;
  readonly color: string;
  /** Harnesses show their mark; families have none. */
  readonly driverKind?: ProviderDriverKind;
}

const HARNESS_SERIES: readonly UsageSeries[] = PROVIDER_ORDER.map((provider) => ({
  key: provider,
  ...PROVIDER_PRESENTATION[provider],
}));

const FAMILY_SERIES: readonly UsageSeries[] = MODEL_FAMILY_ORDER.map((family) => ({
  key: family,
  label: MODEL_FAMILY_LABEL[family],
  color: FAMILY_COLOR[family],
}));

/** Every series of a grouping, in its stable reading order. */
export function seriesFor(groupBy: UsageGroupBy): readonly UsageSeries[] {
  return groupBy === "family" ? FAMILY_SERIES : HARNESS_SERIES;
}

/** A day's or hour's totals per series of the grouping. */
export function periodSeriesTotals(
  period: DailyTotals | HourlyTotals | undefined,
  groupBy: UsageGroupBy,
): ReadonlyMap<UsageSeriesKey, { costUsd: number; totalTokens: number }> | undefined {
  return groupBy === "family" ? period?.byFamily : period?.byProvider;
}
