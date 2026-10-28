import { describe, expect, it } from "vite-plus/test";
import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  compactTrajectoryLabel,
  summarizeAgentTrajectory,
  trajectorySummariesEqual,
} from "./trajectorySummary.js";

const base = {
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-10-27T00:00:00.000Z"),
};

function tool(id: string, toolName: string, input: unknown, status = base.status) {
  return {
    ...base,
    id: TurnItemId.make(id),
    type: "dynamic_tool" as const,
    toolName,
    input,
    status,
  };
}

function command(id: string, input: string) {
  return { ...base, id: TurnItemId.make(id), type: "command_execution" as const, input };
}

function edit(id: string, fileName: string): OrchestrationV2TurnItem {
  return { ...base, id: TurnItemId.make(id), type: "file_change", fileName };
}

describe("summarizeAgentTrajectory", () => {
  it("counts individual invocations once and sorts the breakdown by frequency", () => {
    const read = tool("read-1", "read", { path: "src/main.ts" });
    expect(
      summarizeAgentTrajectory([
        read,
        read,
        tool("read-2", "read", { path: "src/other.ts" }),
        command("shell", "vp test run"),
        {
          ...base,
          id: TurnItemId.make("thinking"),
          type: "reasoning",
          text: "read read read",
          streaming: false,
        },
        { ...base, id: TurnItemId.make("notice"), type: "system_notice", message: "Tool finished" },
      ]),
    ).toEqual([
      {
        kind: "tools",
        label: "Called 3 tools",
        title: "Tool calls",
        details: ["read · 2 calls", "Shell · 1 call"],
      },
    ]);
  });

  it("recognizes and deduplicates skill reads and native skill invocations, not mentions or edits", () => {
    expect(
      summarizeAgentTrajectory([
        tool("native", "Skill", { skill: "git", args: "commit" }),
        tool("read", "functions.read", { path: "/home/user/skills/git/SKILL.md" }),
        tool("read2", "Read", { file_path: "C:\\skills\\design\\SKILL.md" }),
        command("shell", "sed -n '1,200p' '/home/user/skills/review/SKILL.md'"),
        tool("search", "Grep", { pattern: "skills/unused/SKILL.md" }),
        command("mention", "echo /skills/unused/SKILL.md"),
        command("sed-edit", "sed -i 's/old/new/' /skills/unused/SKILL.md"),
        edit("edit", "skills/unused/SKILL.md"),
      ])[0],
    ).toEqual({
      kind: "skills",
      label: "Used 3 skills",
      title: "Skills used",
      details: ["design", "git", "review"],
    });
  });

  it("recognizes namespaced file reads and shell-based skill reads", () => {
    expect(
      summarizeAgentTrajectory([
        tool("read", "mcp__filesystem__read_file", { path: "/skills/git/SKILL.md" }),
        tool("shell", "functions.exec_command", { command: "cat /skills/review/SKILL.md" }),
      ])[0],
    ).toEqual({
      kind: "skills",
      label: "Used 2 skills",
      title: "Skills used",
      details: ["git", "review"],
    });
  });

  it("does not count unsuccessful reads as skills used, but includes failed tool calls", () => {
    const failed: OrchestrationV2TurnItem = {
      ...tool("read", "read", { path: "/skills/git/SKILL.md" }),
      status: "failed",
    };
    expect(summarizeAgentTrajectory([failed])).toEqual([
      { kind: "tools", label: "Called 1 tool", title: "Tool calls", details: ["read · 1 call"] },
    ]);
  });

  it("counts unsuccessful shell calls without claiming their skill reads", () => {
    expect(
      summarizeAgentTrajectory([
        { ...command("failed", "cat /skills/failed/SKILL.md"), exitCode: 1 },
        { ...command("pending", "cat /skills/pending/SKILL.md"), status: "running" },
        command("done", "cat /skills/git/SKILL.md"),
      ]),
    ).toEqual([
      { kind: "skills", label: "Used 1 skill", title: "Skills used", details: ["git"] },
      { kind: "tools", label: "Called 3 tools", title: "Tool calls", details: ["Shell · 3 calls"] },
    ]);
  });

  it("counts file changes as tool calls without a files cluster", () => {
    expect(summarizeAgentTrajectory([edit("edit", "a.ts")])).toEqual([
      {
        kind: "tools",
        label: "Called 1 tool",
        title: "Tool calls",
        details: ["File edit · 1 call"],
      },
    ]);
  });

  it("omits empty clusters and compares detail changes for cached timeline rows", () => {
    expect(summarizeAgentTrajectory([])).toEqual([]);
    const first = summarizeAgentTrajectory([tool("1", "read", { path: "/skills/git/SKILL.md" })]);
    expect(
      trajectorySummariesEqual(
        first,
        summarizeAgentTrajectory([tool("2", "read", { path: "/skills/git/SKILL.md" })]),
      ),
    ).toBe(true);
    expect(
      trajectorySummariesEqual(
        first,
        summarizeAgentTrajectory([tool("3", "read", { path: "/skills/design/SKILL.md" })]),
      ),
    ).toBe(false);
  });
});

describe("compactTrajectoryLabel", () => {
  it.each([
    ["Worked for 34s", "34s"],
    ["Continued for 2m", "2m"],
    ["Used 2 skills", "2 skills"],
    ["Called 3 tools", "3 tools"],
    ["Worked", "Worked"],
    ["Used ", "Used "],
    ["", ""],
    ["Still Worked for 34s", "Still Worked for 34s"],
    ["Called \n", "\n"],
  ])("compacts only a leading prefix with a remaining value: %j", (label, expected) => {
    expect(compactTrajectoryLabel(label)).toBe(expected);
  });
});
