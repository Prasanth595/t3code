import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  notificationAsync: vi.fn(),
}));

vi.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Error: "error" },
  notificationAsync: mocks.notificationAsync,
}));

vi.mock("./vcs", () => ({ vcsActionManager: {} }));

import { dismissGitActionResult, showGitActionResult } from "./use-vcs-action-state";

describe("showGitActionResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.notificationAsync.mockResolvedValue(undefined);
    dismissGitActionResult();
  });

  it("buzzes success once when a git action succeeds", () => {
    showGitActionResult({ type: "success", title: "Pushed" });

    expect(mocks.notificationAsync).toHaveBeenCalledTimes(1);
    expect(mocks.notificationAsync).toHaveBeenCalledWith("success");
  });

  it("buzzes error when a git action fails, even right after a success", () => {
    showGitActionResult({ type: "success", title: "Pushed" });
    showGitActionResult({ type: "error", title: "Git action failed", description: "rejected" });

    expect(mocks.notificationAsync).toHaveBeenLastCalledWith("error");
    expect(mocks.notificationAsync).toHaveBeenCalledTimes(2);
  });
});
