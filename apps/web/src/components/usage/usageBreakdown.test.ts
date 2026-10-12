import type { ModelTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import {
  cacheHitRate,
  costPerMillionTokens,
  modelShare,
  reasoningEffortRows,
  sortModelsByTokens,
} from "./usageBreakdown";

const model = (
  name: string,
  totalTokens: number,
  costUsd: number,
  overrides: Partial<ModelTotals> = {},
): ModelTotals => ({
  model: name,
  provider: "codex",
  costUsd,
  totalTokens,
  tokens: {
    uncachedInputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  },
  records: 1,
  unpricedRecords: 0,
  unpricedTokens: 0,
  costShare: 0,
  tokenShare: 0,
  ...overrides,
});

describe("sortModelsByTokens", () => {
  it("sorts by tokens, breaks ties by cost, and leaves the input alone", () => {
    const models = [
      model("lower-cost", 100, 1),
      model("more-tokens", 200, 2),
      model("higher-cost", 100, 3),
    ];

    expect(sortModelsByTokens(models).map((item) => item.model)).toEqual([
      "more-tokens",
      "higher-cost",
      "lower-cost",
    ]);
    expect(models.map((item) => item.model)).toEqual(["lower-cost", "more-tokens", "higher-cost"]);
  });
});

describe("modelShare", () => {
  it("follows the selected metric", () => {
    const priced = model("priced", 100, 9, { costShare: 0.9, tokenShare: 0.25 });

    expect(modelShare(priced, "cost")).toBe(0.9);
    expect(modelShare(priced, "tokens")).toBe(0.25);
  });

  it("has no cost share for an unknown cost but keeps its token share", () => {
    const unpriced = model("unpriced", 300, 0, {
      unpricedRecords: 1,
      unpricedTokens: 300,
      tokenShare: 0.75,
    });

    expect(modelShare(unpriced, "cost")).toBeNull();
    expect(modelShare(unpriced, "tokens")).toBe(0.75);
  });
});

describe("model rates", () => {
  it("counts cache writes as misses and leaves unpriced tokens out of $/1M", () => {
    const mixed = model("mixed", 4_000_000, 6, {
      tokens: {
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheCreationTokens: 2_000_000,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      records: 4,
      unpricedRecords: 1,
      unpricedTokens: 1_000_000,
    });

    expect(cacheHitRate(mixed)).toBe(0.25);
    expect(costPerMillionTokens(mixed)).toBe(2);
    expect(costPerMillionTokens({ ...mixed, unpricedRecords: 4 })).toBeNull();
  });
});

describe("reasoning effort presentation", () => {
  it("orders effort consistently and counts reasoning inside output once", () => {
    const effort = (name: string) => ({
      effort: name,
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 1000,
        cacheCreationTokens: 0,
        outputTokens: 50,
        reasoningTokens: 20,
      },
      costUsd: 1,
      records: 1,
      unpricedRecords: 0,
    });
    const rows = reasoningEffortRows(
      model("gpt-6-astra", 3450, 3, {
        reasoningEfforts: [effort("unknown"), effort("xhigh"), effort("low")],
      }),
    );
    expect(rows.map((row) => row.effort)).toEqual(["low", "xhigh", "unknown"]);
    expect(rows.map((row) => row.totalTokens)).toEqual([1150, 1150, 1150]);
    expect(new Set(rows.map((row) => row.color)).size).toBe(3);
    expect(reasoningEffortRows(model("old-model", 100, 0))[0]?.effort).toBe("unknown");
  });
});
