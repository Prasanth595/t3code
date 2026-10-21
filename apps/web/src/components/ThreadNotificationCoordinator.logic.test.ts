import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadCompletionNotification } from "./ThreadNotificationCoordinator.logic";

const COMPLETED_AT = "2026-10-20T12:00:00.000Z";

function thread(
  overrides: Partial<Pick<EnvironmentThreadShell, "latestRun">> = {},
): Pick<EnvironmentThreadShell, "latestRun"> {
  return {
    latestRun: {
      runId: RunId.make("run-1"),
      status: "completed",
      requestedAt: null,
      startedAt: null,
      completedAt: COMPLETED_AT,
      assistantMessageId: null,
    },
    ...overrides,
  };
}

describe("completion notifications", () => {
  it("stays silent when a completed thread's watch is stopped", () => {
    const watching = resolveThreadCompletionNotification(thread(), false, null, false);
    expect(watching.notify).toBe(false);

    const stopped = resolveThreadCompletionNotification(thread(), true, watching.completion, true);
    expect(stopped.notify).toBe(false);
  });

  it("notifies when a later run completes after stopping a watch", () => {
    const watching = resolveThreadCompletionNotification(thread(), false, null, false);
    const stopped = resolveThreadCompletionNotification(thread(), true, watching.completion, true);
    const completed = resolveThreadCompletionNotification(
      thread({
        latestRun: {
          ...thread().latestRun!,
          runId: RunId.make("run-2"),
          completedAt: "2026-10-20T12:01:00.000Z",
        },
      }),
      true,
      stopped.completion,
      false,
    );
    expect(completed.notify).toBe(true);
  });

  it("notifies once when a run completes without a watch", () => {
    const completed = resolveThreadCompletionNotification(thread(), true, null, false);
    expect(completed.notify).toBe(true);
    expect(
      resolveThreadCompletionNotification(thread(), true, completed.completion, false).notify,
    ).toBe(false);
  });

  it("notifies when watching finishes normally", () => {
    const pending = resolveThreadCompletionNotification(thread(), false, null, false);
    expect(pending.notify).toBe(false);
    expect(
      resolveThreadCompletionNotification(thread(), true, pending.completion, false).notify,
    ).toBe(true);
  });

  it.each(["interrupted", "cancelled", "failed"] as const)(
    "does not notify for a %s run",
    (status) => {
      const completed = resolveThreadCompletionNotification(
        thread({ latestRun: { ...thread().latestRun!, status } }),
        true,
        null,
        false,
      );
      expect(completed.notify).toBe(false);
    },
  );
});
