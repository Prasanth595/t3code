import type { ThreadContextUsage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import {
  buildContextBreakdownView,
  formatContextHeadlinePercentage,
  formatContextPercentage,
} from "./ThreadContextSection.logic";

function snapshot(overrides: Partial<ContextWindowSnapshot>): ContextWindowSnapshot {
  return {
    usedTokens: 0,
    totalProcessedTokens: null,
    maxTokens: null,
    remainingTokens: null,
    usedPercentage: null,
    remainingPercentage: null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: null,
    autoCompactThreshold: null,
    cost: null,
    updatedAt: "2026-10-16T00:00:00.000Z",
    ...overrides,
  };
}

const claudeUsage: ThreadContextUsage = {
  model: "claude-opus-5-5",
  usedTokens: 99_000,
  maxTokens: 1_000_000,
  categories: [
    { name: "System prompt", tokens: 4_900, kind: "used" },
    { name: "Messages", tokens: 47_600, kind: "used" },
    { name: "Custom agents", tokens: 0, kind: "used" },
    { name: "Compact buffer", tokens: 3_000, kind: "buffer" },
    { name: "Free space", tokens: 898_000, kind: "free" },
    { name: "System tools (deferred)", tokens: 22_400, kind: "deferred" },
  ],
  groups: [
    {
      id: "memory-files",
      items: [{ name: "C:/repo/CLAUDE.md", tokens: 1_200, detail: "Project" }],
    },
    { id: "skills", items: [] },
  ],
};

describe("buildContextBreakdownView", () => {
  it("lists a provider's categories with their share of the window", () => {
    const view = buildContextBreakdownView(snapshot({ usedTokens: 1 }), claudeUsage);

    expect(view?.source).toBe("categories");
    expect(view?.usedPercentage).toBeCloseTo(9.9);
    expect(view?.rows.map((row) => [row.label, row.kind, row.swatch])).toEqual([
      ["System prompt", "used", "pink"],
      ["Messages", "used", "blue"],
      ["Compact buffer", "buffer", "buffer"],
      ["Free space", "free", "free"],
    ]);
    expect(view?.rows[1]?.percentage).toBeCloseTo(4.76);
    expect(view?.deferredRows).toEqual([
      {
        label: "System tools (deferred)",
        tokens: 22_400,
        kind: "deferred",
        swatch: "deferred",
        percentage: null,
      },
    ]);
    expect(view?.groups).toEqual([
      {
        id: "memory-files",
        label: "Memory files",
        items: [{ name: "C:/repo/CLAUDE.md", tokens: 1_200, detail: "Project" }],
      },
    ]);
  });

  it("keeps an unknown category's color stable", () => {
    const usage = {
      ...claudeUsage,
      categories: [{ name: "Plugin hooks", tokens: 10, kind: "used" as const }],
    };

    const first = buildContextBreakdownView(null, usage)?.rows[0]?.swatch;
    const second = buildContextBreakdownView(null, usage)?.rows[0]?.swatch;

    expect(first).toBe(second);
  });

  it("splits a total whose input includes cache reads so rows add up to the total", () => {
    // Claude and OpenCode fold cache reads into inputTokens.
    const view = buildContextBreakdownView(
      snapshot({
        usedTokens: 50_000,
        maxTokens: 200_000,
        inputTokens: 48_000,
        cachedInputTokens: 40_000,
        outputTokens: 2_000,
      }),
      null,
    );

    expect(view?.source).toBe("totals");
    expect(view?.rows.map((row) => [row.label, row.tokens])).toEqual([
      ["Cached input", 40_000],
      ["New input", 8_000],
      ["Output", 2_000],
      ["Free space", 150_000],
    ]);
    expect(view?.usedPercentage).toBe(25);
  });

  it("does not double count reasoning that a provider includes in output", () => {
    const view = buildContextBreakdownView(
      snapshot({
        usedTokens: 30_000,
        maxTokens: 258_000,
        inputTokens: 28_000,
        cachedInputTokens: 20_000,
        outputTokens: 2_000,
        reasoningOutputTokens: 1_500,
      }),
      null,
    );

    const usedRows = view?.rows.filter((row) => row.kind === "used") ?? [];
    expect(usedRows.reduce((sum, row) => sum + row.tokens, 0)).toBe(30_000);
  });

  it("shows one used row for providers that only report a total", () => {
    // ACP agents send `used` and `size` only.
    const view = buildContextBreakdownView(
      snapshot({ usedTokens: 12_000, maxTokens: 128_000 }),
      null,
    );

    expect(view?.rows.map((row) => [row.label, row.tokens])).toEqual([
      ["Used", 12_000],
      ["Free space", 116_000],
    ]);
  });

  it("leaves out free space and shares when the window size is unknown", () => {
    const view = buildContextBreakdownView(snapshot({ usedTokens: 9_000 }), null);

    expect(view?.usedPercentage).toBeNull();
    expect(view?.rows).toEqual([
      { label: "Used", tokens: 9_000, kind: "used", swatch: "blue", percentage: null },
    ]);
  });

  it("has nothing to show before any usage is reported", () => {
    expect(buildContextBreakdownView(null, null)).toBeNull();
  });
});

describe("context percentages", () => {
  it("formats row shares to one decimal and marks tiny ones", () => {
    expect(formatContextPercentage(3.56)).toBe("3.6%");
    expect(formatContextPercentage(0.04)).toBe("<0.1%");
    expect(formatContextPercentage(null)).toBe("—");
  });

  it("rounds the headline and never shows a started window as 0%", () => {
    expect(formatContextHeadlinePercentage(9.9)).toBe("10%");
    expect(formatContextHeadlinePercentage(0.3)).toBe("<1%");
  });
});
