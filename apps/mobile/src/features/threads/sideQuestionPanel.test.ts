import { describe, expect, it } from "vite-plus/test";
import {
  beginSideQuestion,
  finishSideQuestion,
  type SideQuestionPanelState,
} from "./sideQuestionPanel";

describe("mobile side question panel", () => {
  it("opens a bare command without starting a request", () => {
    const opened = beginSideQuestion(null, "thread", "panel", "");
    expect(opened).toEqual({
      id: "panel",
      threadKey: "thread",
      focusKey: 0,
      exchanges: [],
      pending: false,
      error: null,
    });
  });

  it("focuses an existing pending panel without losing the request or its history", () => {
    const answered = finishSideQuestion(
      beginSideQuestion(null, "thread", "first", "Why?"),
      "first",
      { answer: "Because." },
    );
    const pending = beginSideQuestion(answered, "thread", "second", "How?");
    const focused = beginSideQuestion(pending, "thread", "unused", "");
    expect(focused?.id).toBe(pending?.id);
    expect(focused?.exchanges).toBe(pending?.exchanges);
    expect(focused?.focusKey).toBe(1);
    expect(focused?.pending).toBe(true);
    expect(beginSideQuestion(focused, "thread", "rejected", "Another?")).toBeNull();
    const finished = finishSideQuestion(focused, "second", { answer: "This way." });
    expect(finished?.pending).toBe(false);
    expect(finished?.exchanges.at(-1)?.answer).toBe("This way.");
    const refocused = beginSideQuestion(finished, "thread", "unused", "");
    expect(refocused?.exchanges).toBe(finished?.exchanges);
    expect(refocused?.focusKey).toBe(2);
  });

  it("starts pending immediately and rejects overlapping asks", () => {
    const pending = beginSideQuestion(null, "thread", "first", "Why?");
    expect(pending?.pending).toBe(true);
    expect(pending?.exchanges).toEqual([{ id: "first", question: "Why?", answer: null }]);
    expect(beginSideQuestion(pending, "thread", "second", "Why again?")).toBeNull();
  });

  it.each([{ answer: "Old answer" }, { error: "Old failure" }])(
    "ignores an old result after dismissal and reopening: %j",
    (result) => {
      const reopened: SideQuestionPanelState = {
        id: "reopened",
        threadKey: "thread",
        focusKey: 0,
        exchanges: [],
        pending: false,
        error: null,
      };
      expect(finishSideQuestion(null, "first", result)).toBeNull();
      expect(finishSideQuestion(reopened, "first", result)).toBe(reopened);
      const newer = beginSideQuestion(reopened, "thread", "second", "Why?");
      expect(finishSideQuestion(newer, "first", result)).toBe(newer);
    },
  );

  it("keeps follow-up history and gives identical questions separate identities", () => {
    const first = beginSideQuestion(null, "thread", "first", "Why?");
    const answered = finishSideQuestion(first, "first", { answer: "Because.", synthetic: true });
    const followUp = beginSideQuestion(answered, "thread", "second", "Why?");
    expect(followUp?.id).toBe(first?.id);
    expect(followUp?.exchanges).toEqual([
      { id: "first", question: "Why?", answer: "Because.", synthetic: true },
      { id: "second", question: "Why?", answer: null },
    ]);
    expect(finishSideQuestion(followUp, "first", { answer: "Duplicate" })).toBe(followUp);
    expect(finishSideQuestion(followUp, "second", { answer: "More detail." })?.pending).toBe(false);
  });

  it("keeps a failed question with its error, and a retry replaces it", () => {
    const failed = finishSideQuestion(beginSideQuestion(null, "thread", "first", "Why?"), "first", {
      error: "Connection lost",
    });
    expect(failed?.pending).toBe(false);
    expect(failed?.error).toBe("Connection lost");
    expect(failed?.exchanges).toEqual([{ id: "first", question: "Why?", answer: null }]);
    const retry = beginSideQuestion(failed, "thread", "retry", "Why?");
    expect(retry?.exchanges).toEqual([{ id: "retry", question: "Why?", answer: null }]);
    expect(retry?.error).toBeNull();
  });

  it("starts fresh when the selected thread changes", () => {
    const pending = beginSideQuestion(null, "old", "first", "Why?");
    const next = beginSideQuestion(pending, "new", "second", "What?");
    expect(next?.threadKey).toBe("new");
    expect(next?.exchanges).toHaveLength(1);
    expect(finishSideQuestion(next, "first", { answer: "Old" })).toBe(next);
  });
});
