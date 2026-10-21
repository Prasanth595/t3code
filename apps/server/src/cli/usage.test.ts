import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { formatUsageLimits } from "./usage.ts";

const now = Date.parse("2026-10-21T10:00:00.000Z");

it("prints each account's remaining quota and reset countdown, or why it has none", () => {
  const text = formatUsageLimits(
    {
      createdAt: "2026-10-21T10:00:00.000Z",
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
            {
              id: "secondary",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 100,
              remainingPercent: 0,
              resetsAt: null,
              windowDurationMins: null,
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
      notices: ["Team hub: Connection refused."],
    },
    now,
  );

  assert.strictEqual(
    text,
    [
      "codex [codex] · Pro · read 5m ago",
      "  5h                72% left · resets in 2h 10m",
      "  Weekly             0% left",
      "Claude [claudeAgent]",
      "  No limits reported.",
      "Team hub: Connection refused.",
    ].join("\n"),
  );
});
