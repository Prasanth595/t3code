import { MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage } from "../../types";
import { latestSettledReplyId, nextPromptRequestTarget } from "./useNextPromptSuggestion.logic";

const message = (
  id: string,
  role: ChatMessage["role"],
  overrides: Partial<ChatMessage> = {},
): ChatMessage => ({
  id: MessageId.make(id),
  role,
  text: id,
  runId: null,
  streaming: false,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
  ...overrides,
});

describe("latestSettledReplyId", () => {
  it("returns the assistant message the thread ends on", () => {
    expect(latestSettledReplyId([message("u1", "user"), message("a1", "assistant")])).toBe("a1");
  });

  it("is null while the reply is still streaming or once the user has written after it", () => {
    expect(
      latestSettledReplyId([
        message("u1", "user"),
        message("a1", "assistant", { streaming: true }),
      ]),
    ).toBeNull();
    expect(latestSettledReplyId([message("a1", "assistant"), message("u2", "user")])).toBeNull();
  });

  it("looks past system notices", () => {
    expect(latestSettledReplyId([message("a1", "assistant"), message("s1", "system")])).toBe("a1");
  });
});

describe("nextPromptRequestTarget", () => {
  const threadId = ThreadId.make("thread-a");
  const replyId = MessageId.make("a1");

  it("asks about the reply of a run the user watched finish", () => {
    expect(
      nextPromptRequestTarget({
        phase: "ready",
        threadId,
        watchedRunningThreadId: threadId,
        replyId,
      }),
    ).toBe(replyId);
  });

  it("never asks for a thread that was only opened", () => {
    expect(
      nextPromptRequestTarget({ phase: "ready", threadId, watchedRunningThreadId: null, replyId }),
    ).toBeNull();
    expect(
      nextPromptRequestTarget({
        phase: "ready",
        threadId,
        watchedRunningThreadId: ThreadId.make("thread-b"),
        replyId,
      }),
    ).toBeNull();
  });

  it("waits for the run to settle and for a reply to exist", () => {
    expect(
      nextPromptRequestTarget({
        phase: "running",
        threadId,
        watchedRunningThreadId: threadId,
        replyId,
      }),
    ).toBeNull();
    expect(
      nextPromptRequestTarget({
        phase: "ready",
        threadId,
        watchedRunningThreadId: threadId,
        replyId: null,
      }),
    ).toBeNull();
  });
});
