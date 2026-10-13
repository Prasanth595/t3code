import { type RuntimeRequestId } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  summarizePendingUserInputAnswer,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  disabled?: boolean;
  respondingRequestIds: RuntimeRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  /** Moves past an answered question; never called on the last one. */
  onAdvance: () => void;
  onSelectQuestion: (questionIndex: number) => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  disabled = false,
  respondingRequestIds,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onSelectQuestion,
  onDismiss,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      disabled={disabled}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      onSelectQuestion={onSelectQuestion}
      onDismiss={onDismiss}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  disabled,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onSelectQuestion,
  onDismiss,
}: {
  prompt: PendingUserInput;
  disabled: boolean;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onAdvance: () => void;
  onSelectQuestion: (questionIndex: number) => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
}) {
  // Message-mode requests remain answerable after their provider turn ends.
  const canRespond = prompt.responseCapability !== "not_resumable";
  const responseDisabled = disabled || isResponding || !canRespond;
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const onAdvanceRef = useRef(onAdvance);
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionValue: string;
  } | null>(null);
  // Collapsing hides everything but the header so a tall prompt stops covering
  // the thread the user is trying to read. Scoped to a single question: the card
  // is keyed by request id so the next prompt starts expanded, and storing the
  // collapsed question's id (rather than a bare flag) reopens the card when the
  // prompt advances to its next question, which can happen without a click —
  // sending from the composer advances the active question.
  const [collapsedQuestionId, setCollapsedQuestionId] = useState<string | null>(null);
  const isCollapsed = collapsedQuestionId !== null && collapsedQuestionId === activeQuestion?.id;

  useEffect(() => {
    onAdvanceRef.current = onAdvance;
  }, [onAdvance]);

  useEffect(() => {
    if (!activeQuestion || activeQuestion.multiSelect || !optimisticSingleSelect) {
      return;
    }
    if (optimisticSingleSelect.questionId !== activeQuestion.id) {
      setOptimisticSingleSelect(null);
      return;
    }
    if (
      progress.customAnswer.trim().length === 0 &&
      progress.selectedOptionValues.includes(optimisticSingleSelect.optionValue)
    ) {
      setOptimisticSingleSelect(null);
    }
  }, [
    activeQuestion,
    optimisticSingleSelect,
    progress.customAnswer,
    progress.selectedOptionValues,
  ]);

  // A delayed answer only advances its own question, while permission remains granted.
  useEffect(() => {
    const clearAutoAdvance = () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
        autoAdvanceTimerRef.current = null;
      }
    };
    if (disabled || activeQuestion?.id === undefined) clearAutoAdvance();
    return clearAutoAdvance;
  }, [activeQuestion?.id, disabled]);

  // Choosing an option moves on to the next question, but never submits: the
  // last question waits for Submit so a click can't send answers by accident.
  const handleOptionSelection = useCallback(
    (questionId: string, optionValue: string) => {
      if (disabled || isResponding) return;
      if (activeQuestion?.multiSelect) {
        onToggleOption(questionId, optionValue);
        return;
      }
      setOptimisticSingleSelect({ questionId, optionValue });
      onToggleOption(questionId, optionValue);
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
        autoAdvanceTimerRef.current = null;
      }
      if (progress.isLastQuestion) return;
      autoAdvanceTimerRef.current = window.setTimeout(() => {
        autoAdvanceTimerRef.current = null;
        onAdvanceRef.current();
      }, 200);
    },
    [activeQuestion, disabled, isResponding, onToggleOption, progress.isLastQuestion],
  );

  // Keyboard shortcuts when focus is outside editable fields: number keys 1-9
  // select the corresponding option, and left/right arrows switch questions.
  // Collapsed prompts opt out, since what the keys refer to is not on screen.
  useEffect(() => {
    if (!activeQuestion || responseDisabled || isCollapsed) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const nextIndex = progress.questionIndex + (event.key === "ArrowLeft" ? -1 : 1);
        if (nextIndex < 0 || nextIndex >= prompt.questions.length) return;
        event.preventDefault();
        onSelectQuestion(nextIndex);
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      handleOptionSelection(activeQuestion.id, option.value ?? option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [
    activeQuestion,
    handleOptionSelection,
    isCollapsed,
    onSelectQuestion,
    progress.questionIndex,
    prompt.questions.length,
    responseDisabled,
  ]);

  if (!activeQuestion) {
    return null;
  }

  const customAnswerActive = progress.customAnswer.trim().length > 0;

  return (
    <Collapsible
      open={!isCollapsed}
      onOpenChange={(open) => {
        setCollapsedQuestionId(open ? null : activeQuestion.id);
      }}
    >
      <CollapsibleTrigger
        render={<ComposerBanner.Row render={<button type="button" />} />}
        title={
          isCollapsed ? "Show the question and its options" : "Hide the question and its options"
        }
        data-pending-user-input-toggle={isCollapsed ? "collapsed" : "expanded"}
      >
        <ComposerBanner.Icon />
        <ComposerBanner.Content>
          <span className="shrink-0 font-medium text-muted-foreground">
            {isCollapsed || prompt.questions.length === 1
              ? activeQuestion.header
              : `${progress.answeredQuestionCount} of ${prompt.questions.length} answered`}
          </span>
          {isCollapsed ? (
            <span className="min-w-0 flex-1 truncate text-secondary-label">
              {activeQuestion.question}
            </span>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          {isCollapsed && prompt.questions.length > 1 ? (
            <span className="text-3xs font-medium text-muted-foreground tabular-nums">
              {questionIndex + 1}/{prompt.questions.length}
            </span>
          ) : null}
          <ComposerBanner.ToggleIcon expanded={!isCollapsed} />
          {prompt.dismissible ? (
            // Sits inside the trigger button, so stop the click from toggling
            // the disclosure. Dismiss closes the question without a reply.
            <ComposerBanner.Dismiss
              render={<span role="button" tabIndex={0} />}
              aria-label="Dismiss question without answering"
              title="Dismiss question without answering"
              disabled={isResponding}
              data-pending-user-input-dismiss
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDismiss(prompt.requestId);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                onDismiss(prompt.requestId);
              }}
            />
          ) : null}
        </ComposerBanner.Actions>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {prompt.questions.length > 1 ? (
          <ComposerBanner.Body className="flex items-center justify-between gap-2 pe-1 pb-2">
            <div
              role="tablist"
              aria-label="Questions"
              className="flex w-fit min-w-0 gap-0.5 overflow-x-auto rounded-lg bg-input/40 p-0.5 [scrollbar-width:none]"
            >
              {prompt.questions.map((question, index) => {
                const summary = summarizePendingUserInputAnswer(question, answers[question.id]);
                const isActive = index === progress.questionIndex;
                return (
                  <button
                    key={question.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    aria-label={summary ? `${question.header}: ${summary}` : question.header}
                    data-pending-user-input-tab={summary === null ? "unanswered" : "answered"}
                    onClick={() => onSelectQuestion(index)}
                    className={cn(
                      // Matches the segmented toggle; the marker matches the setup wizard's steps.
                      "flex h-6 max-w-56 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      isActive
                        ? "bg-background text-foreground shadow-xs/10 dark:bg-input/72"
                        : "text-muted-foreground hover:bg-background/55 hover:text-foreground dark:hover:bg-input/32",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "grid size-3.5 shrink-0 place-items-center rounded-full text-3xs tabular-nums ring-1",
                        summary !== null
                          ? "bg-primary text-primary-foreground ring-primary"
                          : "ring-black/10 dark:ring-white/10",
                      )}
                    >
                      {summary !== null ? <CheckIcon className="size-2.5" /> : index + 1}
                    </span>
                    <span className="min-w-0 truncate">
                      {question.header}
                      {summary !== null ? (
                        <span className="font-normal text-muted-foreground">: {summary}</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="flex shrink-0 items-center">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Previous question"
                disabled={progress.questionIndex === 0}
                onClick={() => onSelectQuestion(progress.questionIndex - 1)}
              >
                <ChevronLeftIcon className="size-3.5" />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Next question"
                disabled={progress.isLastQuestion}
                onClick={() => onSelectQuestion(progress.questionIndex + 1)}
              >
                <ChevronRightIcon className="size-3.5" />
              </Button>
            </div>
          </ComposerBanner.Body>
        ) : null}
        <ComposerBanner.Scroll>
          <ComposerBanner.Body className="pe-1 pb-1 wrap-anywhere">
            <p className="text-sm text-foreground/85">{activeQuestion.question}</p>
            {activeQuestion.multiSelect ? (
              <p className="mt-1 text-secondary-label text-xs">Select one or more options.</p>
            ) : null}
            <div className="mt-2 space-y-0.5">
              {activeQuestion.options.map((option, index) => {
                const optionValue = option.value ?? option.label;
                const isOptimisticallySelected =
                  optimisticSingleSelect?.questionId === activeQuestion.id &&
                  optimisticSingleSelect.optionValue === optionValue;
                const isSelected =
                  isOptimisticallySelected ||
                  (!customAnswerActive && progress.selectedOptionValues.includes(optionValue));
                const shortcutKey = index < 9 ? index + 1 : null;
                const className = cn(
                  "group flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25",
                  isSelected
                    ? "bg-muted/55 text-foreground"
                    : "bg-transparent text-foreground/85 hover:bg-muted/30",
                  (disabled || isResponding) && "opacity-50 cursor-not-allowed",
                  !disabled && !isResponding && "cursor-pointer",
                );
                const content = (
                  <>
                    <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{option.label}</span>
                      {option.description && option.description !== option.label ? (
                        <span className="text-secondary-label text-2xs">{option.description}</span>
                      ) : null}
                    </div>
                    {isSelected ? (
                      <CheckIcon className="size-3.5 shrink-0 text-primary" />
                    ) : shortcutKey !== null ? (
                      <kbd
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center text-3xs font-medium text-muted-foreground tabular-nums",
                        )}
                      >
                        {shortcutKey}
                      </kbd>
                    ) : null}
                  </>
                );
                return (
                  <button
                    key={`${activeQuestion.id}:${optionValue}`}
                    type="button"
                    disabled={disabled || isResponding}
                    onClick={() => {
                      handleOptionSelection(activeQuestion.id, optionValue);
                    }}
                    className={className}
                  >
                    {content}
                  </button>
                );
              })}
            </div>
          </ComposerBanner.Body>
        </ComposerBanner.Scroll>
      </CollapsiblePanel>
    </Collapsible>
  );
});
