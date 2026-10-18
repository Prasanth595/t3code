import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

it("cancels an answer's pending auto-submit on revocation and resumes after a new grant", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onToggleOption = vi.fn();
  const onAdvance = vi.fn();
  const onDismiss = vi.fn();
  const prompt = {
    requestId: RuntimeRequestId.make("scoped-answer"),
    createdAt: "2026-09-05T00:00:00.000Z",
    dismissible: false,
    responseCapability: "live" as const,
    questions: [
      {
        id: "approach",
        header: "Approach",
        question: "Which approach?",
        options: [{ label: "Incremental", description: "One module at a time" }],
        multiSelect: false,
      },
    ],
  };
  const panel = (disabled: boolean) => (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[prompt]}
      cwd="/repo"
      threadRef={threadRef}
      disabled={disabled}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      isAnswering
      onToggleAnswering={() => {}}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      onDismiss={onDismiss}
    />
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  // A disabled button swallows the click, as it would for a user.
  const chooseOption = () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Incremental"))!
      .click();
  try {
    await act(async () => root.render(panel(false)));
    await act(async () => chooseOption());
    expect(onToggleOption).toHaveBeenCalledWith("approach", "Incremental");
    expect(onAdvance).not.toHaveBeenCalled();

    await act(async () => root.render(panel(true)));
    await act(async () => {
      chooseOption();
      vi.runAllTimers();
    });
    expect(onToggleOption).toHaveBeenCalledTimes(1);
    expect(onAdvance).not.toHaveBeenCalled();

    await act(async () => root.render(panel(false)));
    await act(async () => {
      chooseOption();
      vi.runAllTimers();
    });
    expect(onToggleOption).toHaveBeenCalledTimes(2);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

it("keeps Back to message available after the operate grant is revoked", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const prompt = {
    requestId: RuntimeRequestId.make("revoked-answer"),
    createdAt: "2026-09-05T00:00:00.000Z",
    dismissible: false,
    responseCapability: "live" as const,
    questions: [
      {
        id: "approach",
        header: "Approach",
        question: "Which approach?",
        options: [{ label: "Incremental", description: "One module at a time" }],
        multiSelect: false,
      },
    ],
  };
  const panel = (isAnswering: boolean) => (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[prompt]}
      cwd="/repo"
      threadRef={threadRef}
      disabled
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      isAnswering={isAnswering}
      onToggleAnswering={() => {}}
      onToggleOption={() => {}}
      onAdvance={() => {}}
      onDismiss={() => {}}
    />
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const toggleButton = (label: string) => {
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(label),
    );
    expect(button).toBeDefined();
    return button!;
  };
  try {
    await act(async () => root.render(panel(true)));
    expect(toggleButton("Back to message").disabled).toBe(false);

    await act(async () => root.render(panel(false)));
    expect(toggleButton("Answer question").disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
