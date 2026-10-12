import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { useComposerDraftStore } from "../../composerDraftStore";
import { collectInlineContextIds } from "../../lib/composerContextReferences";
import { threadContextRecord } from "../../lib/composerContextRecords";
import {
  buildPendingUserInputAnswers,
  projectPendingUserInputAnswer,
} from "../../pendingUserInput";
import { questionAttachmentDraftId } from "../../questionAttachments";
import { insertDroppedThreadContexts } from "./composerThreadDrop";

const environmentId = EnvironmentId.make("env-drop");
const composerTarget = { environmentId, threadId: ThreadId.make("answering-thread") };
const record = threadContextRecord(
  { environmentId, threadId: ThreadId.make("reference-thread") },
  "Reference work",
);
const questionTarget = questionAttachmentDraftId(
  environmentId,
  composerTarget.threadId,
  "request",
  "question",
);

beforeEach(() => {
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  useComposerDraftStore.getState().setPrompt(composerTarget, "Unsent main draft");
});

describe("insertDroppedThreadContexts", () => {
  it("puts the reference in the answer and sends its payload without changing the main draft", () => {
    let answer = "Compare ";
    const store = useComposerDraftStore.getState();
    const mainDraft = store.getComposerDraft(composerTarget);
    expect(
      insertDroppedThreadContexts({
        records: [record],
        composerTarget,
        questionTarget,
        canAnswer: true,
        insertAnswerText: (text) => {
          answer += text;
          return true;
        },
        addThreadContexts: store.addThreadContexts,
      }),
    ).toBe(true);
    const questionDraft = useComposerDraftStore.getState().getComposerDraft(questionTarget);
    expect(collectInlineContextIds(answer)).toEqual([record.contextId]);
    expect(questionDraft?.threadContexts).toEqual([record]);
    expect(questionDraft?.prompt).toBe("");
    expect(useComposerDraftStore.getState().getComposerDraft(composerTarget)).toBe(mainDraft);

    const answers = buildPendingUserInputAnswers(
      [{ id: "question", header: "Compare", question: "What should we compare?", options: [] }],
      { question: { customAnswer: answer } },
    );
    const projected = projectPendingUserInputAnswer(
      answers?.question,
      questionDraft?.threadContexts ?? [],
    );
    expect(projected).toBe("Compare [Reference work](t3-thread://v1/reference-thread)");
    expect(projected).not.toContain("t3-context://");
  });

  it("keeps references separate when moving to another question", () => {
    const nextQuestionTarget = questionAttachmentDraftId(
      environmentId,
      composerTarget.threadId,
      "request",
      "next-question",
    );
    const nextRecord = threadContextRecord(
      { environmentId, threadId: ThreadId.make("next-reference") },
      "Other work",
    );
    for (const [target, dropped] of [
      [questionTarget, record],
      [nextQuestionTarget, nextRecord],
    ] as const) {
      insertDroppedThreadContexts({
        records: [dropped],
        composerTarget,
        questionTarget: target,
        canAnswer: true,
        insertAnswerText: () => true,
        addThreadContexts: useComposerDraftStore.getState().addThreadContexts,
      });
    }
    const store = useComposerDraftStore.getState();
    expect(store.getComposerDraft(questionTarget)?.threadContexts).toEqual([record]);
    expect(store.getComposerDraft(nextQuestionTarget)?.threadContexts).toEqual([nextRecord]);
    expect(store.getComposerDraft(composerTarget)?.threadContexts).toEqual([]);
  });

  it.each([
    { canAnswer: false, insertResult: true },
    { canAnswer: true, insertResult: false },
  ])("does not fall back to the main draft when the answer rejects a drop: %j", (state) => {
    const mainDraft = useComposerDraftStore.getState().getComposerDraft(composerTarget);
    expect(
      insertDroppedThreadContexts({
        records: [record],
        composerTarget,
        questionTarget,
        canAnswer: state.canAnswer,
        insertAnswerText: () => state.insertResult,
        addThreadContexts: useComposerDraftStore.getState().addThreadContexts,
      }),
    ).toBe(false);
    const store = useComposerDraftStore.getState();
    expect(store.getComposerDraft(composerTarget)).toBe(mainDraft);
    expect(store.getComposerDraft(questionTarget)).toBeNull();
  });

  it("still adds a reference to the main draft after the question closes", () => {
    insertDroppedThreadContexts({
      records: [record],
      composerTarget,
      questionTarget: null,
      canAnswer: false,
      insertAnswerText: () => false,
      addThreadContexts: useComposerDraftStore.getState().addThreadContexts,
    });
    const draft = useComposerDraftStore.getState().getComposerDraft(composerTarget);
    expect(draft?.prompt).toContain("Unsent main draft");
    expect(collectInlineContextIds(draft?.prompt ?? "")).toEqual([record.contextId]);
    expect(draft?.threadContexts).toEqual([record]);
  });
});

describe("projectPendingUserInputAnswer", () => {
  it("omits a deleted reference and retains its payload for undo", () => {
    expect(projectPendingUserInputAnswer("Plain answer", [record])).toBe("Plain answer");
  });

  it("preserves option values and exact answer text", () => {
    const options = [" first\t", "second"];
    expect(projectPendingUserInputAnswer(options, [record])).toBe(options);
    expect(projectPendingUserInputAnswer("  Edited answer\n", [record])).toBe("  Edited answer\n");
  });
});
