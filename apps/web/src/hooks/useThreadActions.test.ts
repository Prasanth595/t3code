import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { navigateAfterThreadDeletion, useContinueThread } from "./useThreadActions";
import { toastManager } from "../components/ui/toast";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { makeThreadFixture } from "../test-fixtures";

const continuation = vi.hoisted(() => ({
  readThreadShell: vi.fn<(typeof import("../state/entities"))["readThreadShell"]>(),
  canOperate: vi.fn<() => boolean>(),
  startTurn: vi.fn(),
}));

vi.mock(import("../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  readThreadShell: continuation.readThreadShell,
}));
vi.mock(import("../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  readEnvironmentScope: continuation.canOperate,
}));
vi.mock("../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => continuation.startTurn,
}));

describe("navigateAfterThreadDeletion", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a rejected navigation without failing the completed deletion", async () => {
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("navigation-error");

    await expect(
      navigateAfterThreadDeletion(() => Promise.reject(new Error("route unavailable"))),
    ).resolves.toBeUndefined();

    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Thread deleted, but navigation failed",
        description: "route unavailable",
      }),
    );
  });
});

const continuationTarget = {
  environmentId: EnvironmentId.make("secondary"),
  threadId: ThreadId.make("thread"),
};

function setupContinuation() {
  continuation.canOperate.mockReset().mockReturnValue(true);
  continuation.startTurn.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  const thread = makeThreadFixture({
    id: continuationTarget.threadId,
    environmentId: continuationTarget.environmentId,
    latestRun: {
      status: "failed",
      runId: RunId.make("failed-run"),
      requestedAt: null,
      startedAt: null,
      completedAt: null,
      assistantMessageId: null,
    },
    runtimeMode: "approval-required",
    interactionMode: "plan",
  });
  continuation.readThreadShell.mockReset().mockReturnValue(thread);
  return { thread, continueThread: useContinueThread() };
}

describe("continueThread", () => {
  it("continues the target run in its own environment without changing its modes", async () => {
    const { continueThread } = setupContinuation();
    const result = await continueThread(continuationTarget);
    expect(result._tag).toBe("Success");
    expect(continuation.startTurn).toHaveBeenCalledExactlyOnceWith({
      environmentId: continuationTarget.environmentId,
      input: {
        threadId: continuationTarget.threadId,
        manualContinuationOfRunId: RunId.make("failed-run"),
        message: {
          messageId: expect.any(String),
          role: "user",
          text: "Continue where you left off.",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        dispatchMode: "start",
      },
    });
    expect(continuation.readThreadShell).toHaveBeenCalledWith(continuationTarget);
  });

  it("does not send a continuation after permission is revoked", async () => {
    const { continueThread } = setupContinuation();
    continuation.canOperate.mockReturnValue(false);
    const result = await continueThread(continuationTarget);
    expect(result._tag).toBe("Failure");
    expect(continuation.startTurn).not.toHaveBeenCalled();
  });

  it("rechecks the run instead of continuing a stale failure", async () => {
    const { thread, continueThread } = setupContinuation();
    continuation.readThreadShell.mockReturnValue({
      ...thread,
      latestRun: { ...thread.latestRun!, status: "completed" },
    });
    await continueThread(continuationTarget);
    expect(continuation.startTurn).not.toHaveBeenCalled();
  });

  it("does not send a continuation after the thread disappears", async () => {
    const { continueThread } = setupContinuation();
    continuation.readThreadShell.mockReturnValue(null);
    await continueThread(continuationTarget);
    expect(continuation.startTurn).not.toHaveBeenCalled();
  });

  it("returns dispatch failures for the menu to report", async () => {
    const { continueThread } = setupContinuation();
    const failure = AsyncResult.failure(Cause.fail(new Error("Environment disconnected")));
    continuation.startTurn.mockResolvedValue(failure);
    expect(await continueThread(continuationTarget)).toBe(failure);
  });
});
