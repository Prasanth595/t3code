import { afterEach, describe, expect, it } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  beginSideQuestion,
  finishSideQuestion,
  sideQuestionPanelsAtom,
  updateSideQuestionPanel,
  type SideQuestionPanelState,
} from "./sideQuestionPanel";

afterEach(() => {
  appAtomRegistry.set(sideQuestionPanelsAtom, {});
});

describe("mobile side question panel", () => {
  it("opens a bare command without starting a request", () => {
    const opened = beginSideQuestion(null, "panel", "");
    expect(opened).toEqual({
      id: "panel",
      focusKey: 0,
      exchanges: [],
      pending: false,
      error: null,
      hidden: false,
    });
  });

  it("focuses an existing pending panel without losing the request or its history", () => {
    const answered = finishSideQuestion(beginSideQuestion(null, "first", "Why?"), "first", {
      answer: "Because.",
    });
    const pending = beginSideQuestion(answered, "second", "How?");
    const focused = beginSideQuestion(pending, "unused", "");
    expect(focused?.id).toBe(pending?.id);
    expect(focused?.exchanges).toBe(pending?.exchanges);
    expect(focused?.focusKey).toBe(3);
    expect(focused?.pending).toBe(true);
    expect(beginSideQuestion(focused, "rejected", "Another?")).toBeNull();
    const finished = finishSideQuestion(focused, "second", { answer: "This way." });
    expect(finished?.pending).toBe(false);
    expect(finished?.exchanges.at(-1)?.answer).toBe("This way.");
    const refocused = beginSideQuestion(finished, "unused", "");
    expect(refocused?.exchanges).toBe(finished?.exchanges);
    expect(refocused?.focusKey).toBe(4);
  });

  it("starts pending immediately and rejects overlapping asks", () => {
    const pending = beginSideQuestion(null, "first", "Why?");
    expect(pending?.pending).toBe(true);
    expect(pending?.exchanges).toEqual([{ id: "first", question: "Why?", answer: null }]);
    expect(beginSideQuestion(pending, "second", "Why again?")).toBeNull();
  });

  it.each([{ answer: "Old answer" }, { error: "Old failure" }])(
    "ignores an old result after dismissal and reopening: %j",
    (result) => {
      const reopened: SideQuestionPanelState = {
        id: "reopened",
        focusKey: 0,
        exchanges: [],
        pending: false,
        error: null,
        hidden: false,
      };
      expect(finishSideQuestion(null, "first", result)).toBeNull();
      expect(finishSideQuestion(reopened, "first", result)).toBe(reopened);
      const newer = beginSideQuestion(reopened, "second", "Why?");
      expect(finishSideQuestion(newer, "first", result)).toBe(newer);
    },
  );

  it("keeps follow-up history and gives identical questions separate identities", () => {
    const first = beginSideQuestion(null, "first", "Why?");
    const answered = finishSideQuestion(first, "first", { answer: "Because.", synthetic: true });
    const followUp = beginSideQuestion(answered, "second", "Why?");
    expect(followUp?.id).toBe(first?.id);
    expect(followUp?.exchanges).toEqual([
      { id: "first", question: "Why?", answer: "Because.", synthetic: true },
      { id: "second", question: "Why?", answer: null },
    ]);
    expect(finishSideQuestion(followUp, "first", { answer: "Duplicate" })).toBe(followUp);
    expect(finishSideQuestion(followUp, "second", { answer: "More detail." })?.pending).toBe(false);
  });

  it("keeps a failed question with its error, and a retry replaces it", () => {
    const failed = finishSideQuestion(beginSideQuestion(null, "first", "Why?"), "first", {
      error: "Connection lost",
    });
    expect(failed?.pending).toBe(false);
    expect(failed?.error).toBe("Connection lost");
    expect(failed?.exchanges).toEqual([{ id: "first", question: "Why?", answer: null }]);
    const retry = beginSideQuestion(failed, "retry", "Why?");
    expect(retry?.exchanges).toEqual([{ id: "retry", question: "Why?", answer: null }]);
    expect(retry?.error).toBeNull();
  });

  it("keeps each thread's panel and lands a late answer in its own thread", () => {
    updateSideQuestionPanel("thread-a", (current) => beginSideQuestion(current, "a1", "Why?"));
    updateSideQuestionPanel("thread-b", (current) => beginSideQuestion(current, "b1", "What?"));
    updateSideQuestionPanel("thread-a", (current) =>
      finishSideQuestion(current, "a1", { answer: "Because." }),
    );
    const panels = appAtomRegistry.get(sideQuestionPanelsAtom);
    expect(panels["thread-a"]?.pending).toBe(false);
    expect(panels["thread-a"]?.exchanges.at(-1)?.answer).toBe("Because.");
    expect(panels["thread-b"]?.pending).toBe(true);
    expect(panels["thread-b"]?.exchanges).toEqual([{ id: "b1", question: "What?", answer: null }]);
  });

  it("keeps answers hidden by Dismiss and shows them again on a bare /btw", () => {
    updateSideQuestionPanel("thread", (current) => beginSideQuestion(current, "first", "Why?"));
    updateSideQuestionPanel("thread", (current) => current && { ...current, hidden: true });
    updateSideQuestionPanel("thread", (current) =>
      finishSideQuestion(current, "first", { answer: "Because." }),
    );
    expect(appAtomRegistry.get(sideQuestionPanelsAtom)["thread"]?.hidden).toBe(true);
    const reopened = updateSideQuestionPanel("thread", (current) =>
      beginSideQuestion(current, "unused", ""),
    );
    expect(reopened?.hidden).toBe(false);
    expect(reopened?.exchanges.at(-1)?.answer).toBe("Because.");
  });
});
