import type {
  ThreadContextUsage,
  ThreadContextUsageCategoryKind,
  ThreadContextUsageGroup,
} from "@t3tools/contracts";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";

export type ContextSwatch =
  | "blue"
  | "orange"
  | "emerald"
  | "amber"
  | "violet"
  | "pink"
  | "sky"
  | "lime"
  | "buffer"
  | "free"
  | "deferred";

export interface ContextBreakdownRow {
  readonly label: string;
  readonly tokens: number;
  readonly kind: ThreadContextUsageCategoryKind;
  readonly swatch: ContextSwatch;
  /** Share of the whole window, 0-100. `null` when the window size is unknown. */
  readonly percentage: number | null;
}

export interface ContextBreakdownGroup {
  readonly id: ThreadContextUsageGroup["id"];
  readonly label: string;
  readonly items: ThreadContextUsageGroup["items"];
}

export interface ContextBreakdownView {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly usedPercentage: number | null;
  /** Rows that occupy or describe the window, in the provider's order. */
  readonly rows: ReadonlyArray<ContextBreakdownRow>;
  /** Out-of-window rows, listed for awareness without a share. */
  readonly deferredRows: ReadonlyArray<ContextBreakdownRow>;
  readonly groups: ReadonlyArray<ContextBreakdownGroup>;
  /** `categories` when the provider measured what fills the window, `totals` otherwise. */
  readonly source: "categories" | "totals";
}

const CATEGORY_PALETTE = [
  "blue",
  "orange",
  "emerald",
  "amber",
  "violet",
  "pink",
  "sky",
  "lime",
] as const satisfies ReadonlyArray<ContextSwatch>;

// Claude's categories keep the same colors across refreshes and threads.
const KNOWN_CATEGORY_SWATCHES: Readonly<Record<string, ContextSwatch>> = {
  messages: "blue",
  "memory files": "orange",
  "system tools": "emerald",
  "mcp tools": "amber",
  skills: "violet",
  "system prompt": "pink",
  "custom agents": "sky",
  "mcp server instructions": "lime",
};

const GROUP_LABELS: Readonly<Record<ThreadContextUsageGroup["id"], string>> = {
  "mcp-tools": "MCP tools",
  "memory-files": "Memory files",
  skills: "Skills",
  agents: "Custom agents",
};

function categorySwatch(label: string): ContextSwatch {
  const known = KNOWN_CATEGORY_SWATCHES[label.trim().toLowerCase()];
  if (known) return known;
  let hash = 0;
  for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return CATEGORY_PALETTE[hash % CATEGORY_PALETTE.length]!;
}

function percentageOf(tokens: number, maxTokens: number | null): number | null {
  return maxTokens !== null && maxTokens > 0 ? (tokens / maxTokens) * 100 : null;
}

function fromCategories(usage: ThreadContextUsage): ContextBreakdownView {
  const maxTokens = usage.maxTokens ?? null;
  const rows: ContextBreakdownRow[] = [];
  const deferredRows: ContextBreakdownRow[] = [];
  for (const category of usage.categories) {
    if (category.tokens === 0 && category.kind !== "free") continue;
    const row: ContextBreakdownRow = {
      label: category.name,
      tokens: category.tokens,
      kind: category.kind,
      swatch: category.kind === "used" ? categorySwatch(category.name) : category.kind,
      percentage: category.kind === "deferred" ? null : percentageOf(category.tokens, maxTokens),
    };
    (category.kind === "deferred" ? deferredRows : rows).push(row);
  }
  return {
    usedTokens: usage.usedTokens,
    maxTokens,
    usedPercentage: percentageOf(usage.usedTokens, maxTokens),
    rows,
    deferredRows,
    groups: usage.groups
      .filter((group) => group.items.length > 0)
      .map((group) => ({ id: group.id, label: GROUP_LABELS[group.id], items: group.items })),
    source: "categories",
  };
}

/**
 * Splits the latest usage report into what every provider can say about it.
 * Rows always add up to the used total: whatever is not cached input or output
 * is counted as new input, so providers that fold cache reads into
 * `inputTokens` and ones that do not land on the same rows.
 */
function fromTotals(snapshot: ContextWindowSnapshot): ContextBreakdownView {
  const usedTokens = Math.max(0, snapshot.usedTokens);
  const maxTokens =
    snapshot.maxTokens != null && snapshot.maxTokens > 0 ? snapshot.maxTokens : null;
  const rows: ContextBreakdownRow[] = [];
  const used = (label: string, tokens: number, swatch: ContextSwatch) => {
    if (tokens <= 0) return;
    rows.push({ label, tokens, kind: "used", swatch, percentage: percentageOf(tokens, maxTokens) });
  };
  if (snapshot.cachedInputTokens != null || snapshot.outputTokens != null) {
    const cached = Math.min(usedTokens, Math.max(0, snapshot.cachedInputTokens ?? 0));
    const output = Math.min(usedTokens - cached, Math.max(0, snapshot.outputTokens ?? 0));
    used("Cached input", cached, "sky");
    used("New input", usedTokens - cached - output, "blue");
    used("Output", output, "emerald");
  } else {
    used("Used", usedTokens, "blue");
  }
  if (maxTokens !== null) {
    const free = Math.max(0, maxTokens - usedTokens);
    rows.push({
      label: "Free space",
      tokens: free,
      kind: "free",
      swatch: "free",
      percentage: percentageOf(free, maxTokens),
    });
  }
  return {
    usedTokens,
    maxTokens,
    usedPercentage: percentageOf(usedTokens, maxTokens),
    rows,
    deferredRows: [],
    groups: [],
    source: "totals",
  };
}

/** The provider's own breakdown when it reported one, else the latest usage totals. */
export function buildContextBreakdownView(
  snapshot: ContextWindowSnapshot | null,
  usage: ThreadContextUsage | null,
): ContextBreakdownView | null {
  if (usage !== null) return fromCategories(usage);
  if (snapshot !== null) return fromTotals(snapshot);
  return null;
}

export function formatContextPercentage(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${value.toFixed(1)}%`;
}

/** Whole percent for the headline, matching how much of the window is gone. */
export function formatContextHeadlinePercentage(value: number): string {
  if (value > 0 && value < 1) return "<1%";
  return `${Math.round(value)}%`;
}
