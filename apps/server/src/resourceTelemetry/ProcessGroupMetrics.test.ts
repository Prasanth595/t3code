import { assert, describe, it } from "@effect/vitest";
import type { ResourceTelemetryProcess } from "@t3tools/contracts";

import { groupProcesses } from "./ProcessGroupMetrics.ts";

const process = (
  pid: number,
  ppid: number,
  name: string,
  category: ResourceTelemetryProcess["category"] = "server-child",
) =>
  ({
    identity: { pid, startTimeMs: 1 },
    ppid,
    name,
    category,
    residentBytes: pid * 1_000,
    cpuPercent: pid,
  }) as ResourceTelemetryProcess;

describe("groupProcesses", () => {
  it("sums each direct child of the server with its whole subtree", () => {
    const totals = groupProcesses([
      process(10, 1, "node", "server"),
      process(11, 10, "t3-resource-mon", "resource-monitor"),
      process(20, 10, "claude"),
      process(21, 20, "bash"),
      process(22, 21, "cargo"),
      process(30, 10, "codex"),
      process(40, 10, "zsh"),
      process(50, 10, "chrome-headless"),
      process(60, 10, "git"),
      process(70, 99, "orphan"),
    ]);

    assert.deepStrictEqual(Object.fromEntries(totals), {
      server: { residentBytes: 10_000, cpuPercent: 10, count: 1 },
      "resource-monitor": { residentBytes: 11_000, cpuPercent: 11, count: 1 },
      // The agent's shell and the build it ran belong to the agent, not the terminal group.
      claude: { residentBytes: 63_000, cpuPercent: 63, count: 3 },
      codex: { residentBytes: 30_000, cpuPercent: 30, count: 1 },
      terminal: { residentBytes: 40_000, cpuPercent: 40, count: 1 },
      browser: { residentBytes: 50_000, cpuPercent: 50, count: 1 },
      other: { residentBytes: 130_000, cpuPercent: 130, count: 2 },
    });
  });
});
