import {
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type UsageBucket,
  type UsageSummary,
} from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useUsage: vi.fn(),
  groupBy: "harness" as "harness" | "family",
}));

vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useCanGoBack: () => true,
}));
vi.mock("../../state/usage", () => ({ useUsage: testState.useUsage }));
vi.mock("./usagePagePreferences", () => ({
  readUsagePagePreferences: () => ({ metric: "cost", windowDays: 30, groupBy: testState.groupBy }),
  saveUsagePagePreferences: vi.fn(),
}));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectItem: "div",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "div",
}));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "span",
  WorkspaceBreadcrumbText: "span",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("./UsageProviderChart", () => ({ UsageProviderChart: "div" }));
vi.mock("./UsagePriceOverrides", () => ({ UsagePriceOverrides: () => null }));

import { UsagePage } from "./UsagePage";
import type { UsageGroupBy } from "./usageProviders";

function bucket(overrides: Partial<UsageBucket>): UsageBucket {
  return {
    day: UsageDay.make("2026-08-11"),
    provider: "claude",
    model: "claude-opus-5-5",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    costUsd: 10,
    cacheSavingsUsd: 0,
    costSource: "modelPriced",
    records: 2,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}

const summary: UsageSummary = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-08-11T12:37:00.000Z",
  sinceDay: UsageDay.make("2026-08-10"),
  untilDay: UsageDay.make("2026-08-11"),
  timeZone: "UTC",
  buckets: [
    bucket({}),
    bucket({ provider: "codex", model: "claude-opus-5-5" }),
    bucket({ provider: "codex", model: "gpt-6-1-sol", records: 1 }),
  ],
  sources: (["claude", "codex"] as const).map((provider) => ({
    fingerprint: {
      hostId: "host",
      provider,
      resolvedHomePath: `/home/${provider}`,
      volumeId: "1:1",
    },
    status: "ok" as const,
    scannedFiles: 1,
    skippedFiles: 0,
    malformedRecords: 0,
    distinctSessions: 3,
    message: null,
  })),
  pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 1,
};
const environments = [
  {
    environmentId: EnvironmentId.make("test-environment"),
    label: "Test environment",
    isPending: false,
    canReadDiagnostics: true,
    error: null,
    summary,
  },
];

describe("UsagePage grouping", () => {
  let renderer: Root;
  let container: HTMLDivElement;

  async function render(groupBy: UsageGroupBy) {
    testState.groupBy = groupBy;
    testState.useUsage.mockImplementation((window) => {
      const merged = mergeUsage(
        environments.map(({ environmentId, label }) => ({ environmentId, label, summary })),
        USAGE_CONTRACT_VERSION,
      );
      return {
        merged,
        environments,
        selectedEnvironments: environments,
        isPending: false,
        shown: { window, merged },
        isPartial: false,
        refresh: vi.fn(),
      };
    });
    await act(() => renderer.render(<UsagePage />));
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    testState.useUsage.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    renderer = createRoot(container);
  });

  afterEach(async () => {
    await act(() => renderer.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("keeps harness rows with their session counts by default", async () => {
    await render("harness");

    const text = container.textContent ?? "";
    expect(text).toContain("Claude Code");
    expect(text).toContain("3 sessions");
    expect(text).not.toContain("requests");
  });

  it("re-keys rows by model family with request counts", async () => {
    await render("family");

    const text = container.textContent ?? "";
    // Opus run by both harnesses lands in one Anthropic row.
    expect(text).toContain("Anthropic");
    expect(text).toContain("4 requests");
    expect(text).toContain("OpenAI");
    expect(text).toContain("1 request");
    expect(text).not.toContain("3 sessions");
  });
});

// @vitest-environment jsdom
