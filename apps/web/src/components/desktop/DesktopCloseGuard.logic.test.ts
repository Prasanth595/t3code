import { ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatQuitConfirmation, isBusyThreadShell } from "./DesktopCloseGuard.logic";

type ShellFields = Parameters<typeof isBusyThreadShell>[0];
type BackgroundTask = NonNullable<OrchestrationV2ThreadShell["pendingBackgroundTasks"]>[number];

const rootThreadId = ThreadId.make("thread-root");

function shell(fields: Partial<ShellFields> = {}): ShellFields {
  return {
    activityRunStatus: null,
    pendingBackgroundTasks: [],
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId },
    creationSource: "user",
    ...fields,
  } as ShellFields;
}

function backgroundTask(kind: BackgroundTask["kind"]): BackgroundTask {
  return { kind } as BackgroundTask;
}

describe("isBusyThreadShell", () => {
  it.each(["preparing", "starting", "running", "waiting"] as const)(
    "counts a thread whose run is %s",
    (activityRunStatus) => {
      expect(isBusyThreadShell(shell({ activityRunStatus }))).toBe(true);
    },
  );

  it("does not count an idle thread", () => {
    expect(isBusyThreadShell(shell())).toBe(false);
    expect(isBusyThreadShell(shell({ activityRunStatus: undefined }))).toBe(false);
  });

  it("counts a settled thread still waiting on subagents or monitors", () => {
    expect(isBusyThreadShell(shell({ pendingBackgroundTasks: [backgroundTask("subagent")] }))).toBe(
      true,
    );
    expect(isBusyThreadShell(shell({ pendingBackgroundTasks: [backgroundTask("monitor")] }))).toBe(
      true,
    );
  });

  it("does not count a settled thread that only left a command running", () => {
    expect(isBusyThreadShell(shell({ pendingBackgroundTasks: [backgroundTask("command")] }))).toBe(
      false,
    );
  });

  it("counts a provider-native subagent through its parent only", () => {
    const subagent = shell({
      activityRunStatus: "running",
      creationSource: "provider",
      lineage: {
        parentThreadId: rootThreadId,
        relationshipToParent: "subagent",
        rootThreadId,
      },
    });
    expect(isBusyThreadShell(subagent)).toBe(false);
  });
});

describe("formatQuitConfirmation", () => {
  it("names a single busy thread", () => {
    expect(formatQuitConfirmation("T3 Code", ["Fix login"])).toBe(
      'Quit T3 Code?\n"Fix login" is still working. Quitting stops it.',
    );
  });

  it("lists up to three busy threads and counts the rest", () => {
    expect(formatQuitConfirmation("T3 Code", ["A", "B"])).toBe(
      'Quit T3 Code?\n2 threads are still working. Quitting stops them: "A", "B".',
    );
    expect(formatQuitConfirmation("T3 Code", ["A", "B", "C", "D", "E"])).toBe(
      'Quit T3 Code?\n5 threads are still working. Quitting stops them: "A", "B", "C", and 2 more.',
    );
  });
});
