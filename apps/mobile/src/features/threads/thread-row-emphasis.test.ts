import { describe, expect, it } from "vite-plus/test";

import {
  hasThreadRowAsyncQuestion,
  shouldRecedeThreadRow,
  threadRowAccessibilityLabel,
  threadRowStatusText,
} from "./thread-row-emphasis";

describe("thread row with an open async question", () => {
  it("shows Input only while the run keeps working", () => {
    expect(hasThreadRowAsyncQuestion({ status: "working", hasPendingAsyncQuestion: true })).toBe(
      true,
    );
    expect(hasThreadRowAsyncQuestion({ status: "working", hasPendingAsyncQuestion: false })).toBe(
      false,
    );
    expect(hasThreadRowAsyncQuestion({ status: "working" })).toBe(false);
    expect(hasThreadRowAsyncQuestion({ status: "input", hasPendingAsyncQuestion: true })).toBe(
      false,
    );
  });

  it("keeps full emphasis instead of receding like other working rows", () => {
    expect(shouldRecedeThreadRow({ status: "working", selected: false })).toBe(true);
    expect(
      shouldRecedeThreadRow({ status: "working", selected: false, hasAsyncQuestion: true }),
    ).toBe(false);
  });

  it("leaves Working unsaid beside Input but keeps Goal", () => {
    expect(threadRowStatusText({ hasAsyncQuestion: true, label: "Working" })).toBeNull();
    expect(threadRowStatusText({ hasAsyncQuestion: true, label: "Goal" })).toBe("Goal");
    expect(threadRowStatusText({ hasAsyncQuestion: false, label: "Working" })).toBe("Working");
  });

  it("announces the question with the title and queued messages", () => {
    const label = (statusLabel: string | null, hasAsyncQuestion = true) =>
      threadRowAccessibilityLabel({
        title: "Refactor auth",
        hasAsyncQuestion,
        statusLabel,
        hasQueuedMessages: true,
      });
    expect(label("Working")).toBe("Refactor auth, Input, still working, messages queued to send");
    expect(label("Goal")).toBe("Refactor auth, Input, Goal, messages queued to send");
    expect(label("Working", false)).toBe("Refactor auth, messages queued to send");
  });
});
