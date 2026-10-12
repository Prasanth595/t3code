import type { UsageTokenTotals } from "@t3tools/contracts";
import {
  isModelCostUnknown,
  type CategoryCost,
  type ModelTotals,
  type SpeedCost,
} from "@t3tools/shared/usageMerge";

import type { ShareSegment } from "./UsageShareBar";

export function sortModelsByTokens(models: readonly ModelTotals[]) {
  return models.toSorted(
    (left, right) => right.totalTokens - left.totalTokens || right.costUsd - left.costUsd,
  );
}

/**
 * A model's share of the selected metric, or `null` for a cost share of an
 * unknown cost. An unpriced model still has a real token share.
 */
export function modelShare(model: ModelTotals, metric: "cost" | "tokens"): number | null {
  if (metric === "tokens") return model.tokenShare;
  return isModelCostUnknown(model) ? null : model.costShare;
}

/**
 * Share of a model's input read from cache, or `null` without input. Cache
 * writes count as misses: that input was processed in full.
 */
export function cacheHitRate({ tokens }: ModelTotals): number | null {
  const input = tokens.uncachedInputTokens + tokens.cachedInputTokens + tokens.cacheCreationTokens;
  return input === 0 ? null : tokens.cachedInputTokens / input;
}

/** Effective USD per million priced tokens, or `null` when none were priced. */
export function costPerMillionTokens(model: ModelTotals): number | null {
  const pricedTokens = model.totalTokens - model.unpricedTokens;
  return pricedTokens <= 0 || isModelCostUnknown(model)
    ? null
    : (model.costUsd / pricedTokens) * 1_000_000;
}

/** A neutral step between background and foreground, so mixes never borrow a provider's color. */
const ink = (percent: number) =>
  `color-mix(in oklab, var(--foreground) ${percent}%, var(--background))`;

/** Adjacent segments stay above the 15 ΔE separation floor in both themes. */
const TYPE_COLORS = {
  input: ink(60),
  cacheRead: ink(30),
  cacheWrite: ink(72),
  output: ink(100),
  other: ink(44),
};

export function costTypeSegments(cost: CategoryCost): readonly ShareSegment[] {
  return [
    { label: "Input", value: cost.input, color: TYPE_COLORS.input },
    { label: "Cache read", value: cost.cacheRead, color: TYPE_COLORS.cacheRead },
    { label: "Cache write", value: cost.cacheWrite, color: TYPE_COLORS.cacheWrite },
    { label: "Output", value: cost.output, color: TYPE_COLORS.output },
    // Reported cost with no rates to split it, or from older servers. Below a
    // cent it is rounding, not usage.
    { label: "Other", value: cost.unsplit >= 0.005 ? cost.unsplit : 0, color: TYPE_COLORS.other },
  ];
}

export function tokenTypeSegments(
  tokens: Omit<UsageTokenTotals, "reasoningTokens">,
): readonly ShareSegment[] {
  return [
    { label: "Input", value: tokens.uncachedInputTokens, color: TYPE_COLORS.input },
    { label: "Cache read", value: tokens.cachedInputTokens, color: TYPE_COLORS.cacheRead },
    { label: "Cache write", value: tokens.cacheCreationTokens, color: TYPE_COLORS.cacheWrite },
    { label: "Output", value: tokens.outputTokens, color: TYPE_COLORS.output },
  ];
}

/** Speeds are ordered by price, so they brighten from standard to ultrafast. */
export function speedCostSegments(cost: SpeedCost): readonly ShareSegment[] {
  return [
    { label: "Standard", value: cost.standard, color: ink(34) },
    { label: "Fast", value: cost.fast, color: ink(66) },
    { label: "Ultrafast", value: cost.ultrafast, color: ink(100) },
  ];
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
  unknown: "Unknown",
};

const EFFORT_COLORS: Record<string, string> = {
  none: ink(58),
  minimal: "#0891b2",
  low: "#3b82f6",
  medium: "#22c55e",
  high: "#f59e0b",
  xhigh: "#8b5cf6",
  max: "#ef4444",
  ultra: "#ec4899",
};

/** Stable hues identify effort across providers and reporting windows. */
export function reasoningEffortRows(model: ModelTotals) {
  const entries = model.reasoningEfforts ?? [
    {
      effort: "unknown",
      totals: model.tokens,
      costUsd: model.costUsd,
      records: model.records,
      unpricedRecords: model.unpricedRecords,
    },
  ];
  const order = (effort: string) => {
    const index = EFFORT_ORDER.indexOf(effort);
    return index >= 0
      ? index
      : effort === "unknown"
        ? EFFORT_ORDER.length + 1
        : EFFORT_ORDER.length;
  };
  return entries
    .filter((entry) => entry.records > 0)
    .toSorted((a, b) => order(a.effort) - order(b.effort) || a.effort.localeCompare(b.effort))
    .map((entry) => ({
      ...entry,
      label: EFFORT_LABELS[entry.effort] ?? entry.effort,
      totalTokens:
        entry.totals.uncachedInputTokens +
        entry.totals.cachedInputTokens +
        entry.totals.cacheCreationTokens +
        entry.totals.outputTokens,
      color:
        EFFORT_COLORS[entry.effort] === undefined
          ? ink(52)
          : `color-mix(in oklab, ${EFFORT_COLORS[entry.effort]} 80%, var(--foreground))`,
      strokeDasharray: entry.effort === "unknown" ? "4 4" : undefined,
    }));
}
