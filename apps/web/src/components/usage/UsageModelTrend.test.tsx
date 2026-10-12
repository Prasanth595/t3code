// @vitest-environment jsdom
import type { DailyTotals, HourlyTotals, ModelTotals } from "@t3tools/shared/usageMerge";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { buildReasoningPeriodColumns, UsageModelTrend } from "./UsageModelTrend";

const tokenTotals = {
  uncachedInputTokens: 10,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 100,
  reasoningTokens: 80,
};
const model: ModelTotals = {
  provider: "claude",
  model: "claude-fable-5",
  costUsd: 4.8,
  totalTokens: 440,
  tokens: { ...tokenTotals, uncachedInputTokens: 40, outputTokens: 400, reasoningTokens: 320 },
  records: 4,
  unpricedRecords: 0,
  unpricedTokens: 0,
  costShare: 1,
  tokenShare: 1,
  reasoningEfforts: [
    { effort: "low", totals: tokenTotals, costUsd: 1.2, records: 1, unpricedRecords: 0 },
    {
      effort: "xhigh",
      totals: { ...tokenTotals, uncachedInputTokens: 30, outputTokens: 300, reasoningTokens: 240 },
      costUsd: 3.6,
      records: 3,
      unpricedRecords: 0,
    },
  ],
};
const day: DailyTotals = {
  day: "2026-10-01",
  costUsd: 4.8,
  totalTokens: 440,
  byProvider: new Map([["claude", { costUsd: 4.8, totalTokens: 440 }]]),
  byReasoningEffort: new Map([
    ["low", { costUsd: 1.2, totalTokens: 110 }],
    ["xhigh", { costUsd: 3.6, totalTokens: 330 }],
  ]),
};
const chartWindow = {
  days: [day.day, "2026-10-02", "2026-10-03"],
  hours: [],
  resolution: "day" as const,
  timeZone: "UTC",
  referenceTime: undefined,
};

describe("reasoning period columns", () => {
  it("zero-fills gaps and missing efforts for either metric", () => {
    const byPeriod = new Map([[day.day, day]]);
    expect(
      buildReasoningPeriodColumns(chartWindow.days, byPeriod, ["low", "xhigh", "high"], "cost"),
    ).toEqual([
      {
        bands: [
          { id: "low", value: 1.2 },
          { id: "xhigh", value: 3.6 },
          { id: "high", value: 0 },
        ],
        total: 4.8,
      },
      {
        bands: [
          { id: "low", value: 0 },
          { id: "xhigh", value: 0 },
          { id: "high", value: 0 },
        ],
        total: 0,
      },
      {
        bands: [
          { id: "low", value: 0 },
          { id: "xhigh", value: 0 },
          { id: "high", value: 0 },
        ],
        total: 0,
      },
    ]);
    expect(
      buildReasoningPeriodColumns(chartWindow.days, byPeriod, ["low", "xhigh"], "tokens").map(
        (column) => column.total,
      ),
    ).toEqual([440, 0, 0]);
  });
  it("assigns legacy periods to unknown instead of guessing an effort", () => {
    const { byReasoningEffort: _, ...legacy } = day;
    expect(
      buildReasoningPeriodColumns(
        [day.day],
        new Map([[day.day, legacy]]),
        ["low", "unknown"],
        "tokens",
      ),
    ).toEqual([
      {
        bands: [
          { id: "low", value: 0 },
          { id: "unknown", value: 440 },
        ],
        total: 440,
      },
    ]);
  });
});

describe("model effort chart", () => {
  let container: HTMLDivElement;
  let renderer: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    renderer = createRoot(container);
  });
  afterEach(async () => {
    await act(() => renderer.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function hover(fraction = 0) {
    const plot = container.querySelector('svg[aria-label*=" by "]')!.parentElement!;
    vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 400,
      bottom: 224,
      width: 400,
      height: 224,
      toJSON: () => ({}),
    });
    await act(() =>
      plot.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: fraction * 400,
          clientY: 20,
        }),
      ),
    );
    const tooltip = container.querySelector('[role="tooltip"]');
    expect(tooltip).not.toBeNull();
    return tooltip!.textContent;
  }

  it("switches between model and effort trends while following the selected metric", async () => {
    const render = (metric: "cost" | "tokens") =>
      renderer.render(
        <UsageModelTrend
          model={model}
          daily={[day]}
          hourly={[]}
          metric={metric}
          chartWindow={chartWindow}
        />,
      );
    await act(() => render("cost"));
    expect(container.querySelector('[aria-label="Reasoning effort legend"]')).toBeNull();
    const byEffort = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "By effort",
    )!;
    await act(() => byEffort.click());
    expect(await hover()).toContain("Low$1.20Extra high$3.60Total$4.80");
    const colors = [...container.querySelectorAll('path[fill="none"]')].map((path) =>
      path.getAttribute("stroke"),
    );
    expect(new Set(colors).size).toBe(2);
    expect(container.querySelector('[aria-label="Reasoning effort legend"]')?.textContent).toBe(
      "LowExtra high",
    );

    await act(() => render("tokens"));
    expect(await hover()).toContain("Low110Extra high330Total440");
    expect(
      [...container.querySelectorAll('path[fill="none"]')].map((path) =>
        path.getAttribute("stroke"),
      ),
    ).toEqual(colors);
    expect(await hover(0.5)).toContain("Low0Extra high0Total0");

    const all = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "All usage",
    )!;
    await act(() => all.click());
    expect(container.querySelector('[aria-label="Reasoning effort legend"]')).toBeNull();
    expect(await hover()).toContain("Claude Code440Total440");
    const effort = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "By effort",
    )!;
    await act(() => effort.click());
    expect(await hover()).toContain("Low110Extra high330Total440");
  });

  it("uses hourly effort values rather than daily totals", async () => {
    const hour: HourlyTotals = {
      ...day,
      hourStart: "2026-10-01T09:00:00.000Z",
      costUsd: 1.2,
      totalTokens: 110,
      byProvider: new Map([["claude", { costUsd: 1.2, totalTokens: 110 }]]),
      byReasoningEffort: new Map([["low", { costUsd: 1.2, totalTokens: 110 }]]),
    };
    await act(() =>
      renderer.render(
        <UsageModelTrend
          model={model}
          daily={[day]}
          hourly={[hour]}
          metric="cost"
          chartWindow={{
            ...chartWindow,
            resolution: "hour",
            hours: [hour.hourStart, "2026-10-01T10:00:00.000Z"],
          }}
        />,
      ),
    );
    await act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "By effort")!
        .click(),
    );
    expect(await hover()).toContain("Low$1.20Extra high$0.00Total$1.20");
    expect(await hover(1)).toContain("Low$0.00Extra high$0.00Total$0.00");
  });

  it("shows unknown history and falls back to tokens when the model is unpriced", async () => {
    const { reasoningEfforts: _, ...legacyModel } = model;
    const { byReasoningEffort: __, ...legacyDay } = day;
    await act(() =>
      renderer.render(
        <UsageModelTrend
          model={{ ...legacyModel, costUsd: 0, unpricedRecords: 4, unpricedTokens: 440 }}
          daily={[legacyDay]}
          hourly={[]}
          metric="cost"
          chartWindow={chartWindow}
        />,
      ),
    );
    expect(container.textContent).toContain("Tokens over time");
    await act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "By effort")!
        .click(),
    );
    expect(await hover()).toContain("Unknown440Total440");
  });
});
