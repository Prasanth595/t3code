import { ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import type { WorkLogEntry } from "../../session-logic";
import {
  toolCallState,
  toolGroupStats,
  withoutLeadingCd,
  withoutWorkspaceRoot,
} from "./ToolCallCard.logic";

const at = (ms: number) => DateTime.makeUnsafe(new Date(Date.UTC(2026, 9, 27, 12, 0, 0, ms)));

function commandEntry(id: string, startMs: number, endMs: number, exitCode = 0): WorkLogEntry {
  return {
    id,
    createdAt: at(startMs).toString(),
    label: "Ran command",
    tone: "tool",
    command: `cat ${id}`,
    itemType: "command_execution",
    toolLifecycleStatus: "completed",
    structuredPayload: {
      id: TurnItemId.make(id),
      threadId: ThreadId.make("thread"),
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: at(startMs),
      completedAt: at(endMs),
      updatedAt: at(endMs),
      type: "command_execution",
      input: `cat ${id}`,
      exitCode,
    },
  };
}

describe("toolGroupStats", () => {
  it("spans from the first start to the last end and counts failures", () => {
    const stats = toolGroupStats([
      commandEntry("a", 0, 400),
      commandEntry("b", 900, 3_000, 1),
      {
        id: "thought",
        createdAt: at(0).toString(),
        label: "Thought",
        tone: "thinking",
        itemType: "reasoning",
      },
    ]);
    expect(stats).toEqual({ toolCount: 2, failedCount: 1, durationMs: 3_000 });
  });
});

describe("withoutLeadingCd", () => {
  it("drops a leading cd so the row names the command that did the work", () => {
    expect(withoutLeadingCd("cd /repo/worktree; gh pr view 1")).toBe("gh pr view 1");
    expect(withoutLeadingCd('cd "/my repo" && vp test run')).toBe("vp test run");
  });

  it("keeps a bare cd and commands that do not start with cd", () => {
    expect(withoutLeadingCd("cd /repo")).toBe("cd /repo");
    expect(withoutLeadingCd("ls; cd /repo; ls")).toBe("ls; cd /repo; ls");
  });
});

describe("withoutWorkspaceRoot", () => {
  it("shows workspace paths as relative and leaves other paths alone", () => {
    expect(withoutWorkspaceRoot("cat /repo/src/a.ts /etc/hosts", "/repo/")).toBe(
      "cat src/a.ts /etc/hosts",
    );
    expect(withoutWorkspaceRoot("cat /repository/a.ts", "/repo")).toBe("cat /repository/a.ts");
    expect(withoutWorkspaceRoot('grep -rn "tool" /repo --exclude-dir=.git', "/repo")).toBe(
      'grep -rn "tool" . --exclude-dir=.git',
    );
  });
});

describe("toolCallState", () => {
  it("marks an unfinished call outside the working run as stopped, not done", () => {
    const entry = { ...commandEntry("a", 0, 400), toolLifecycleStatus: "inProgress" as const };
    expect(toolCallState(entry, true)).toBe("running");
    expect(toolCallState(entry, false)).toBe("stopped");
  });
});
