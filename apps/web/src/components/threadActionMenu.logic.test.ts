import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  threadContinuationRunId,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";
import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it("puts Continue first for a resumable thread", () => {
    const items = buildThreadActionMenuItems({ ...baseState, canContinue: true });
    expect(items[0]).toMatchObject({ id: "continue", label: "Continue" });
    expect(items[0]?.disabled).not.toBe(true);
  });

  it("omits Continue when there is no resumable run", () => {
    expect(buildThreadActionMenuItems(baseState).some((item) => item.id === "continue")).toBe(
      false,
    );
  });

  it("disables Continue without permission to operate", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      canContinue: true,
      canOperate: false,
    });
    expect(items.find((item) => item.id === "continue")?.disabled).toBe(true);
  });

  it.each([false, true])(
    "allows device-local visibility changes without server permission: %s",
    (hidden) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isHidden: hidden,
      });
      const visibility = items.find((item) => item.id === (hidden ? "unhide" : "hide"));
      expect(visibility?.label).toBe(hidden ? "Restore on this device" : "Hide on this device");
      expect(visibility?.disabled).not.toBe(true);
    },
  );

  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });
});

const stoppedThread = {
  latestRun: {
    runId: RunId.make("failed-run"),
    status: "failed",
    requestedAt: null,
    startedAt: null,
    completedAt: null,
    assistantMessageId: null,
  },
  runtime: null,
  archivedAt: null,
  deletedAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
} satisfies Pick<
  EnvironmentThreadShell,
  | "latestRun"
  | "runtime"
  | "archivedAt"
  | "deletedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
>;

describe("threadContinuationRunId", () => {
  it.each(["failed", "interrupted"] as const)("continues a %s run", (status) => {
    expect(
      threadContinuationRunId({
        ...stoppedThread,
        latestRun: { ...stoppedThread.latestRun, status },
      }),
    ).toBe(stoppedThread.latestRun.runId);
  });

  it.each(["completed", "cancelled", "rolled_back", "queued", "running", "waiting"] as const)(
    "does not continue a %s run",
    (status) => {
      expect(
        threadContinuationRunId({
          ...stoppedThread,
          latestRun: { ...stoppedThread.latestRun, status },
        }),
      ).toBeNull();
    },
  );

  it("does not continue an older failure while a new run is active", () => {
    expect(
      threadContinuationRunId({
        ...stoppedThread,
        runtime: {
          status: "running",
          activeRunId: RunId.make("new-run"),
          providerInstanceId: ProviderInstanceId.make("pi"),
          providerName: "pi",
          lastError: null,
          updatedAt: "2026-10-28T00:00:00Z",
        },
      }),
    ).toBeNull();
  });

  it.each([
    { latestRun: null },
    { archivedAt: "2026-10-28T00:00:00Z" },
    { deletedAt: "2026-10-28T00:00:00Z" },
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
  ])("does not continue an unavailable thread: %j", (overrides) => {
    expect(threadContinuationRunId({ ...stoppedThread, ...overrides })).toBeNull();
  });
});
