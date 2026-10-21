import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { formatUsage } from "./usage.ts";

const now = Date.parse("2026-10-21T10:00:00.000Z");
const tokens = (total: number) => ({
  total,
  uncachedInput: total / 2,
  cachedInput: total / 2,
  cacheCreation: 0,
  output: 0,
  reasoning: 0,
});

it("prints limits with reset countdowns, then spend by provider, model, and day", () => {
  const text = formatUsage(
    {
      createdAt: "2026-10-21T10:00:00.000Z",
      limits: {
        providers: [
          {
            providerInstanceId: ProviderInstanceId.make("codex"),
            driverKind: ProviderDriverKind.make("codex"),
            displayName: null,
            email: null,
            plan: "Pro",
            checkedAt: "2026-10-21T09:55:00.000Z",
            windows: [
              {
                id: "primary",
                kind: "session",
                label: "5h",
                usedPercent: 28,
                remainingPercent: 72,
                resetsAt: "2026-10-21T12:10:00.000Z",
                windowDurationMins: 300,
              },
            ],
            unavailable: null,
          },
          {
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            driverKind: ProviderDriverKind.make("claudeAgent"),
            displayName: "Claude",
            email: null,
            plan: null,
            checkedAt: null,
            windows: [],
            unavailable: { reason: "notReported", message: "No limits reported." },
          },
        ],
        pooledAccounts: [],
      },
      spend: {
        window: {
          days: 7,
          resolution: "day",
          sinceDay: "2026-10-15",
          untilDay: "2026-10-21",
          timeZone: "UTC",
        },
        costUsd: 12.5,
        cacheSavingsUsd: 0,
        unpricedShare: 0.25,
        sessions: 3,
        tokens: tokens(4_000_000),
        costByCategoryUsd: { input: 10, cacheRead: 0, cacheWrite: 0, output: 2.5, unsplit: 0 },
        costBySpeedUsd: { standard: 12.5, fast: 0, ultrafast: 0, premium: 0 },
        providers: [
          { provider: "codex", costUsd: 12.5, totalTokens: 3_000_000, sessions: 2 },
          { provider: "claude", costUsd: 0, totalTokens: 1_000_000, sessions: 1 },
        ],
        models: [
          { provider: "codex", model: "gpt-5.5", costUsd: 12.5, tokens: tokens(3_000_000) },
          { provider: "claude", model: "claude-x", costUsd: null, tokens: tokens(1_000_000) },
        ],
        periods: [{ start: "2026-10-21", costUsd: 12.5, totalTokens: 4_000_000, providers: [] }],
        pricing: { status: "fresh", fetchedAt: null },
      },
      notices: ["Team hub: Connection refused."],
    },
    now,
  );

  assert.strictEqual(
    text,
    [
      "Limits",
      "  codex [codex] · Pro · read 5m ago",
      "    5h                72% left · resets in 2h 10m",
      "  Claude [claudeAgent]",
      "    No limits reported.",
      "Spend · 7 days, 2026-10-15 to 2026-10-21 (UTC) · API estimate",
      "  $12.50 · 4M tokens · 3 sessions · 25.0% unpriced",
      "  Tokens: input 2M · cache read 2M · cache write 0 · output 0 (reasoning 0)",
      "  Cost: input $10.00 · output $2.50",
      "  By provider",
      "    codex            $12.50      3M tokens  2 sessions",
      "    claude            $0.00      1M tokens  1 sessions",
      "  By model",
      "    gpt-5.5          $12.50      3M tokens",
      "    claude-x       unpriced      1M tokens",
      "  By day",
      "    2026-10-21       $12.50      4M tokens",
      "Notices",
      "  Team hub: Connection refused.",
    ].join("\n"),
  );
});
