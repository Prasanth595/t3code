import { DraftId } from "../../composerDraftStore";
import { describe, expect, it, vi } from "vite-plus/test";

import { composerCommandKeyHandler } from "./composerCommandKey";

function setup() {
  const dismiss = vi.fn();
  const submit = vi.fn();
  const saveDraft = vi.fn();
  const promptRef = { current: "" };
  const handler = composerCommandKeyHandler({
    keybindings: [],
    sendShortcut: "enter",
    routeKind: "draft",
    phase: "ready",
    isCompacting: false,
    followUpBehavior: "queue",
    isSoftwareKeyboardOpen: false,
    planModeUiEnabled: false,
    isLiteralPendingAnswer: false,
    pendingUserInputs: [],
    promptHistoryMessages: [],
    promptHistoryPositionRef: { current: null },
    composerDraftTarget: DraftId.make("draft"),
    promptRef,
    composerImagesRef: { current: [] },
    composerFilesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    composerPreviewAnnotations: [],
    composerReviewComments: [],
    promptSuggestion: { text: "Run tests", dismiss },
    composerEditorRef: { current: null },
    composerMenuOpenRef: { current: false },
    composerMenuItemsRef: { current: [] },
    activeComposerMenuItemRef: { current: null },
    setComposerDraftPrompt: saveDraft,
    setComposerCursor: vi.fn(),
    setComposerTrigger: vi.fn(),
    setComposerHighlightedItemId: vi.fn(),
    dismissComposerTrigger: vi.fn(),
    toggleInteractionMode: vi.fn(),
    nudgeComposerMenuHighlight: vi.fn(),
    onSelectComposerItem: vi.fn(),
    resolveActiveComposerTrigger: () => ({ trigger: null }),
    readComposerSnapshot: () => ({ value: "" }),
    applyPromptReplacement: () => false,
    submitComposer: submit,
  });
  return { handler, dismiss, submit, saveDraft, promptRef };
}

describe("next prompt keyboard acceptance", () => {
  it.each(["Tab", "ArrowRight"])("accepts and consumes on %s without sending", (key) => {
    const { handler, dismiss, submit, saveDraft, promptRef } = setup();
    expect(
      handler(key, {
        key,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        isComposing: false,
      } as KeyboardEvent),
    ).toBe(true);
    expect(promptRef.current).toBe("Run tests");
    expect(saveDraft).toHaveBeenCalledWith(DraftId.make("draft"), "Run tests");
    expect(dismiss).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it("dismisses on Escape without changing or sending the draft", () => {
    const { handler, dismiss, submit, saveDraft } = setup();
    expect(
      handler("Escape", {
        key: "Escape",
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        isComposing: false,
      } as KeyboardEvent),
    ).toBe(true);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(saveDraft).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});
