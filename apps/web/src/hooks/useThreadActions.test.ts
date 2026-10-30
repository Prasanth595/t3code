import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { navigateAfterThreadDeletion, runArchivedThreadBatch } from "./useThreadActions";
import { toastManager } from "../components/ui/toast";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";

vi.mock("../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: vi.fn(),
}));

describe("runArchivedThreadBatch", () => {
  afterEach(() => vi.clearAllMocks());

  const local = EnvironmentId.make("environment-local");
  const remote = EnvironmentId.make("environment-remote");
  const targets = [
    scopeThreadRef(local, ThreadId.make("thread-1")),
    scopeThreadRef(local, ThreadId.make("thread-2")),
    scopeThreadRef(remote, ThreadId.make("thread-3")),
  ];

  it("keeps going after a failure and refreshes each environment once", async () => {
    const firstFailure = AsyncResult.failure(Cause.fail(new Error("first")));
    const results = [
      firstFailure,
      AsyncResult.failure(Cause.fail(new Error("second"))),
      AsyncResult.success(undefined),
    ];
    const run = vi.fn(async () => results.shift()!);

    await expect(runArchivedThreadBatch(targets, run)).resolves.toBe(firstFailure);

    expect(run).toHaveBeenCalledTimes(3);
    expect(vi.mocked(refreshArchivedThreadsForEnvironment).mock.calls).toEqual([[local], [remote]]);
  });

  it("stops at an interruption without reporting it", async () => {
    const run = vi.fn(async () => AsyncResult.failure(Cause.interrupt()));

    await expect(runArchivedThreadBatch(targets, run)).resolves.toBeNull();

    expect(run).toHaveBeenCalledOnce();
    expect(vi.mocked(refreshArchivedThreadsForEnvironment).mock.calls).toEqual([[local]]);
  });
});

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
