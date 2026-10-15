import {
  type OrchestrationV2Notification,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  backgroundWorkFromNotification,
  backgroundWorkFromPendingTask,
  linksOnlyMarkdown,
  resolveBackgroundWorkDetails,
} from "./BackgroundWorkDetails.logic.ts";

const threadId = ThreadId.make("thread:parent");
const now = DateTime.makeUnsafe("2026-10-12T06:34:53.624Z");

function baseItem(nativeId: string) {
  return {
    id: TurnItemId.make(`turn-item:${nativeId}`),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: {
      driver: ProviderDriverKind.make("claudeAgent"),
      nativeId,
      strength: "strong" as const,
    },
    parentItemId: null,
    ordinal: 1,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
}

const monitorCall: OrchestrationV2TurnItem = {
  ...baseItem("toolu_monitor"),
  type: "dynamic_tool",
  toolName: "Monitor",
  input: {
    description: "Wait for the live build",
    command: "until [ -s ready ]; do sleep 5; done",
  },
  output: { taskId: "bmonitor" },
};

const shellCall: OrchestrationV2TurnItem = {
  ...baseItem("toolu_shell"),
  type: "command_execution",
  input: "pnpm dev",
  outputOmitted: true,
};

const turnItems = [monitorCall, shellCall];

describe("resolveBackgroundWorkDetails", () => {
  it("finds a running monitor's command through the task id its tool call returned", () => {
    const details = resolveBackgroundWorkDetails(
      turnItems,
      backgroundWorkFromPendingTask({ taskId: "bmonitor", kind: "monitor" }),
    );
    expect(details).toEqual({
      kind: "monitor",
      description: "Wait for the live build",
      definition: "until [ -s ready ]; do sleep 5; done",
      outputFile: undefined,
    });
  });

  it("finds a finished command through the tool call its notification names", () => {
    const notification: OrchestrationV2Notification = {
      source: { kind: "command" },
      outcome: "completed",
      summary: 'Command "Start the dev server" finished',
      tasks: [
        { taskId: "bshell", toolUseId: "toolu_shell", outputFile: "/tmp/tasks/bshell.output" },
      ],
    };
    const [work] = backgroundWorkFromNotification(notification) ?? [];
    expect(work && resolveBackgroundWorkDetails(turnItems, work)).toMatchObject({
      kind: "command",
      definition: "pnpm dev",
      outputFile: "/tmp/tasks/bshell.output",
    });
  });

  it("knows only the kind when the start of the work is unknown", () => {
    const details = resolveBackgroundWorkDetails(
      turnItems,
      backgroundWorkFromPendingTask({ taskId: "bother", kind: "command", description: "Sleep" }),
    );
    expect(details).toEqual({
      kind: "command",
      description: "Sleep",
      definition: undefined,
      outputFile: undefined,
    });
  });

  it("ignores notifications that do not report background work", () => {
    expect(
      backgroundWorkFromNotification({
        source: { kind: "system" },
        outcome: "updated",
        summary: "T3 Code restarted and resumed this turn",
      }),
    ).toBeNull();
  });
});

describe("linksOnlyMarkdown", () => {
  it("keeps only real links as markdown, so a command shows as written", () => {
    expect(linksOnlyMarkdown("rm -rf build/*_old # cleanup")).toBeNull();
    expect(linksOnlyMarkdown("Watch [the log](/tmp/a_b.log) for *_x_*")).toBe(
      "Watch [the log](/tmp/a_b.log) for \\*\\_x\\_\\*",
    );
    expect(linksOnlyMarkdown("[a] b [c d](not a link)")).toBeNull();
  });
});
