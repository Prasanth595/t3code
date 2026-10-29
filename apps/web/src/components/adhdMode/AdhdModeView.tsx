import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PendingUserInputAnswer } from "@t3tools/client-runtime/state/pending-user-input";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  AuthOrchestrationOperateScope,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { CheckIcon, CircleCheckIcon, SparklesIcon, TriangleAlertIcon } from "lucide-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useEffect, useEffectEvent, useState } from "react";

import { isElectron } from "../../env";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useThreadActions } from "../../hooks/useThreadActions";
import { cn, newMessageId } from "../../lib/utils";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { derivePendingApprovals, derivePendingUserInputs } from "../../session-logic";
import {
  useDelegatedUnderParent,
  useQuietThreadProjection,
  useQuietThreadShells,
  useThreadVisibleTurnItems,
} from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import {
  filterSidebarV2VisibleThreads,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  useSnoozeWakeClock,
} from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { InlineButton } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Kbd } from "../ui/kbd";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import type { AdhdCardKind, AdhdQueueEntry } from "@t3tools/client-runtime/state/adhd-queue";
import { buildAdhdQueue } from "./adhdQueue.logic";

const SNOOZE_MS = 15 * 60_000;
const RECOMMENDED_LABEL = /\(recommended\)/i;

const KIND_LABEL: Record<
  AdhdCardKind,
  { label: string; variant: "warning" | "info" | "error" | "success" }
> = {
  approval: { label: "Approval", variant: "warning" },
  input: { label: "Input", variant: "info" },
  failed: { label: "Failed", variant: "error" },
  done: { label: "Done", variant: "success" },
};

const APPROVAL_OPTIONS = [
  { decision: "accept", label: "Approve" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "decline", label: "Decline" },
  { decision: "cancel", label: "Cancel" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

interface QuestionProgress {
  readonly requestId: string;
  readonly index: number;
  readonly answers: Record<string, PendingUserInputAnswer>;
  readonly picked: ReadonlyArray<string>;
}

interface CardOption {
  readonly label: string;
  readonly description?: string | undefined;
  readonly warning?: string | undefined;
}

const threadKeyOf = (entry: AdhdQueueEntry) =>
  scopedThreadKey(scopeThreadRef(entry.thread.environmentId, entry.thread.id));

const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot$="-popup"]';

// Keys typed into a field or an open dialog or menu belong there, not to the card underneath.
function ignoresCardKeys(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
      target.closest(OVERLAY_SELECTOR) !== null)
  );
}

function reportFailure(title: string, result: AsyncResult.AsyncResult<unknown, unknown>) {
  if (result._tag !== "Failure") return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : undefined,
  });
}

export function AdhdModeView() {
  const threads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const projectGroups = useSidebarProjectGroups();
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById);
  const nowMs = useSnoozeWakeClock(threads);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const projectKeys = projectGroups.flatMap((group) =>
    group.memberProjectRefs.map((ref) => ({
      key: `${ref.environmentId}:${ref.projectId}`,
      name: group.displayName,
    })),
  );
  const projectNames = new Map(projectKeys.map((project) => [project.key, project.name]));
  const visibleThreads = new Set(
    filterSidebarV2VisibleThreads(threads, null, delegatedUnderParent),
  );
  const queue = buildAdhdQueue({
    threads: threads.filter(
      (thread) =>
        visibleThreads.has(thread) ||
        // Subagents hide under their parent, but a question of theirs needs its own card.
        (thread.archivedAt === null && (thread.hasPendingApprovals || thread.hasPendingUserInput)),
    ),
    lastVisitedAt: (thread) =>
      resolveThreadLastVisitedAt(
        thread.lastVisitedAt,
        localLastVisitedAt[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
      ),
    projectOrder: projectKeys.map((project) => project.key),
    now: new Date(nowMs).toISOString(),
  });
  // An answered card leaves the queue, so the next one takes its place.
  const currentIndex = Math.max(
    0,
    queue.findIndex((entry) => threadKeyOf(entry) === selectedKey),
  );
  const current = queue[currentIndex] ?? null;
  // Pin the shown card, so a newly urgent thread can't swap it under a key press.
  if (current !== null && selectedKey !== threadKeyOf(current)) {
    setSelectedKey(threadKeyOf(current));
  }
  const workingCount = threads.filter(
    (thread) => thread.archivedAt === null && resolveSidebarThreadStatus(thread) === "working",
  ).length;

  return (
    <SidebarInset
      {...workspaceAreaProps("adhd-mode", 1, "ADHD mode")}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <WorkspacePageHeader electron={isElectron} className="text-sm">
        <h1 className="font-medium">ADHD mode</h1>
        <Badge variant="secondary" size="sm">
          Beta
        </Badge>
        {queue.length > 0 ? (
          <span className="text-muted-foreground">
            {queue.length} need{queue.length === 1 ? "s" : ""} you
            {workingCount > 0 ? ` · ${workingCount} working, hidden` : ""}
          </span>
        ) : null}
      </WorkspacePageHeader>
      <div className="scrollbar-gutter-both flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 pb-8">
        {current === null ? (
          <Empty>
            <EmptyHeader>
              <CircleCheckIcon className="mx-auto size-7 text-success" />
              <EmptyTitle>Nothing needs you</EmptyTitle>
              <EmptyDescription>
                {workingCount > 0
                  ? `${workingCount} agent${workingCount === 1 ? " is" : "s are"} working. They show up here when they stop.`
                  : "Agents show up here when they stop and need you."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex w-full max-w-2xl flex-col gap-4">
            <QueuePips
              queue={queue}
              currentIndex={currentIndex}
              onJump={(index) => setSelectedKey(threadKeyOf(queue[index]!))}
            />
            <AdhdCard
              key={threadKeyOf(current)}
              entry={current}
              projectName={projectNames.get(
                `${current.thread.environmentId}:${current.thread.projectId}`,
              )}
              now={nowMs}
              onJump={(index) => {
                const target = queue[index];
                if (target) setSelectedKey(threadKeyOf(target));
              }}
            />
          </div>
        )}
      </div>
    </SidebarInset>
  );
}

function QueuePips(props: {
  queue: ReadonlyArray<AdhdQueueEntry>;
  currentIndex: number;
  onJump: (index: number) => void;
}) {
  return (
    <nav className="flex items-center justify-center" aria-label="Cards">
      {props.queue.map((entry, index) => (
        <Tooltip key={threadKeyOf(entry)}>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`${index + 1}. ${entry.thread.title}`}
                aria-current={index === props.currentIndex ? "true" : undefined}
                onClick={() => props.onJump(index)}
                className="px-0.5 py-2"
              >
                <span
                  className={cn(
                    "block h-0.5 w-4 rounded-full bg-foreground/15",
                    entry.urgent && "bg-destructive/50",
                    index === props.currentIndex && "bg-foreground",
                  )}
                />
              </button>
            }
          />
          <TooltipPopup side="top">
            {index + 1}. {entry.thread.title}
          </TooltipPopup>
        </Tooltip>
      ))}
    </nav>
  );
}

function AdhdCard(props: {
  entry: AdhdQueueEntry;
  projectName: string | undefined;
  now: number;
  onJump: (index: number) => void;
}) {
  const { entry } = props;
  const { thread } = entry;
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  const router = useRouter();
  const projection = useQuietThreadProjection(ref);
  const turnItems = useThreadVisibleTurnItems(ref);
  const { settleThread, snoozeThread } = useThreadActions();
  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const suggestNextPrompts = useAtomCommand(orchestrationEnvironment.suggestNextPrompts, {
    reportFailure: false,
  });
  const canOperate = readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const wantsSuggestions = entry.kind === "done" || entry.kind === "failed";

  const [suggestions, setSuggestions] = useState<ReadonlyArray<string> | null>(null);
  const [suggestionsFailed, setSuggestionsFailed] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<QuestionProgress | null>(null);

  const requestSuggestions = useEffectEvent(() =>
    suggestNextPrompts({ environmentId: thread.environmentId, input: { threadId: thread.id } }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server's text generation model once per card
  useEffect(() => {
    if (!wantsSuggestions || !canOperate) return;
    let cancelled = false;
    void requestSuggestions().then((result) => {
      if (cancelled) return;
      setSuggestions(result._tag === "Success" ? result.value.prompts : []);
      setSuggestionsFailed(result._tag === "Failure");
    });
    return () => {
      cancelled = true;
    };
  }, [wantsSuggestions, canOperate]);

  const pending = projection === null ? null : derivePendingThreadRequests(projection.projection);
  const approval =
    entry.kind === "approval" && pending
      ? (derivePendingApprovals(pending.approvals)[0] ?? null)
      : null;
  const userInput =
    entry.kind === "input" && pending
      ? (derivePendingUserInputs(pending.userInputs)[0] ?? null)
      : null;
  // Progress belongs to one request; a follow-up request on the same thread starts over.
  const requestProgress =
    userInput !== null && progress?.requestId === userInput.requestId ? progress : null;
  const questionIndex = requestProgress?.index ?? 0;
  const picked = requestProgress?.picked ?? [];
  const question = userInput?.questions[questionIndex] ?? null;

  const approvalOptions = approval?.options ?? APPROVAL_OPTIONS;
  const options: ReadonlyArray<CardOption> =
    entry.kind === "approval"
      ? approvalOptions
      : entry.kind === "input"
        ? (question?.options ?? [])
        : (suggestions ?? []).map((label) => ({ label }));
  const recommended =
    entry.kind === "approval"
      ? approvalOptions.findIndex((option) => option.decision === "accept")
      : entry.kind === "input"
        ? options.findIndex((option) => RECOMMENDED_LABEL.test(option.label))
        : 0;
  const selected = Math.min(highlight ?? Math.max(0, recommended), Math.max(0, options.length - 1));

  const lastAssistantText =
    turnItems.findLast(
      (item) => item.item.type === "assistant_message" && item.item.text.trim().length > 0,
    )?.item ?? null;
  const summary = lastAssistantText?.type === "assistant_message" ? lastAssistantText.text : null;

  const run = async (
    title: string,
    action: () => Promise<AsyncResult.AsyncResult<unknown, unknown>>,
  ) => {
    if (busy || !canOperate) return false;
    setBusy(true);
    const result = await action();
    setBusy(false);
    reportFailure(title, result);
    return result._tag === "Success";
  };

  const sendPrompt = (text: string) =>
    run("Could not send the message", () =>
      startTurn({
        environmentId: thread.environmentId,
        input: {
          threadId: thread.id,
          message: { messageId: newMessageId(), role: "user", text, attachments: [] },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
        },
      }),
    );

  const answerQuestion = async (value: PendingUserInputAnswer) => {
    if (userInput === null || question === null) return false;
    const answers = { ...requestProgress?.answers, [question.id]: value };
    if (questionIndex + 1 < userInput.questions.length) {
      setProgress({
        requestId: userInput.requestId,
        index: questionIndex + 1,
        answers,
        picked: [],
      });
      setHighlight(null);
      return true;
    }
    return run("Could not send the answer", () =>
      respondToUserInput({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, requestId: userInput.requestId, answers },
      }),
    );
  };

  const optionValue = (index: number) => {
    const raw = question?.options[index];
    return raw === undefined ? null : (raw.value ?? raw.label);
  };

  const togglePick = (index: number) => {
    const value = optionValue(index);
    if (userInput === null || value === null) return;
    setProgress({
      requestId: userInput.requestId,
      index: questionIndex,
      answers: requestProgress?.answers ?? {},
      picked: picked.includes(value) ? picked.filter((item) => item !== value) : [...picked, value],
    });
  };

  const accept = (index: number) => {
    const option = options[index];
    if (option === undefined) return;
    if (entry.kind === "approval") {
      if (approval === null || approval.responseCapability !== "live") return;
      const decision: ProviderApprovalDecision = approvalOptions[index]!.decision;
      void run("Could not answer the approval", () =>
        respondToApproval({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, requestId: approval.requestId, decision },
        }),
      );
    } else if (entry.kind === "input") {
      const value = optionValue(index);
      if (value === null) return;
      // With nothing picked, E answers a multi-select question with the highlighted option alone.
      void answerQuestion(question?.multiSelect ? (picked.length > 0 ? picked : [value]) : value);
    } else {
      void sendPrompt(option.label);
    }
  };

  const sendReply = () => {
    // A question's own default answer is sent as written, even when cleared on purpose.
    const keepsRawAnswer = entry.kind === "input" && question?.initialAnswer !== undefined;
    const text = keepsRawAnswer ? reply : reply.trim();
    if (text.length === 0 && !keepsRawAnswer) return;
    // The draft stays until the send goes through, so a failed send can be retried.
    const clearOnSuccess = (sent: boolean) => {
      if (!sent) return;
      setReplying(false);
      setReply("");
    };
    if (entry.kind === "approval") {
      if (approval === null || approval.responseCapability !== "live") return;
      if (!approval.supportsFeedback) {
        toastManager.add({ type: "info", title: "This agent only takes the listed choices here." });
        return;
      }
      void run("Could not answer the approval", () =>
        respondToApproval({
          environmentId: thread.environmentId,
          input: {
            threadId: thread.id,
            requestId: approval.requestId,
            decision: "decline",
            feedback: text,
          },
        }),
      ).then(clearOnSuccess);
    } else if (entry.kind === "input") {
      if (question?.allowCustomAnswer === false) {
        toastManager.add({ type: "info", title: "This question only takes the listed answers." });
        return;
      }
      void answerQuestion(text).then(clearOnSuccess);
    } else {
      void sendPrompt(text).then(clearOnSuccess);
    }
  };

  const snooze = () => {
    if (!canSnooze(thread, { now: new Date(props.now).toISOString() })) {
      toastManager.add({
        type: "info",
        title: "Answer it first",
        description: "A thread can't be snoozed while the agent is waiting on you.",
      });
      return;
    }
    void run("Could not snooze the thread", () =>
      snoozeThread(ref, new Date(Date.now() + SNOOZE_MS).toISOString()),
    );
  };

  const dismiss = () => void run("Could not dismiss the thread", () => settleThread(ref));

  const openThread = () =>
    void router.navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });

  const startReply = () => {
    // A suggested prompt or the question's own default starts as the draft, so a tweak is a small edit.
    if (reply === "") {
      setReply(
        question?.initialAnswer ?? (wantsSuggestions ? (options[selected]?.label ?? "") : ""),
      );
    }
    setReplying(true);
  };

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    // A held key would otherwise answer the next card before it is read.
    if (event.repeat && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (ignoresCardKeys(event.target)) return;
    const key = event.key.toLowerCase();
    // Enter or Space on a focused control activates that control, never the highlighted option.
    if (
      (key === "enter" || key === " ") &&
      event.target instanceof Element &&
      event.target.closest("button, a")
    ) {
      return;
    }
    if (/^[1-9]$/.test(key)) props.onJump(Number(key) - 1);
    else if (key === "arrowdown" && options.length > 0)
      setHighlight(Math.min(selected + 1, options.length - 1));
    else if (key === "arrowup" && options.length > 0) setHighlight(Math.max(selected - 1, 0));
    else if (key === " " && question?.multiSelect) togglePick(selected);
    else if (key === "e" || key === "enter") accept(selected);
    else if (key === "r") startReply();
    else if (key === "backspace") snooze();
    else if (key === "escape") dismiss();
    else if (key === "o") openThread();
    else return;
    event.preventDefault();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the card's keys are document-wide, like the composer's question keys
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  const kind = KIND_LABEL[entry.kind];
  const prompt =
    entry.kind === "approval"
      ? (approval?.reason ?? "The agent wants to run this.")
      : entry.kind === "input"
        ? (question?.question ?? "The agent has a question.")
        : entry.kind === "failed"
          ? "The run failed. Suggested next prompt:"
          : "Finished. Suggested next prompt:";

  return (
    <section
      aria-label={thread.title}
      aria-busy={busy}
      className={cn(
        "flex flex-col gap-4 rounded-2xl border bg-card p-5 text-sm shadow-lg/5",
        busy && "opacity-60",
      )}
    >
      <header className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate">{props.projectName ?? "No project"}</span>
        <span className="ms-auto flex items-center gap-2">
          {entry.urgent ? (
            <span className="font-semibold text-destructive-foreground">Urgent</span>
          ) : null}
          <Badge variant={kind.variant} size="sm">
            {kind.label}
          </Badge>
        </span>
      </header>
      <button
        type="button"
        onClick={openThread}
        className="-mt-2 text-start text-base font-semibold hover:underline"
      >
        {thread.title}
      </button>
      {summary !== null ? (
        <p className="line-clamp-4 whitespace-pre-wrap text-muted-foreground">{summary}</p>
      ) : null}
      {approval?.detail ? (
        <pre className="max-h-32 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">
          {approval.detail}
        </pre>
      ) : null}
      <div className="flex flex-col gap-1">
        <p className="font-medium">
          {prompt}
          {userInput && userInput.questions.length > 1 ? (
            <span className="ms-2 font-normal text-muted-foreground">
              {questionIndex + 1} of {userInput.questions.length}
            </span>
          ) : null}
        </p>
        {wantsSuggestions ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <SparklesIcon className="size-3" />
            {!canOperate
              ? "Suggestions need permission to operate this environment."
              : suggestions === null
                ? "Writing suggestions…"
                : "From your text generation model"}
          </p>
        ) : null}
      </div>
      {options.length > 0 ? (
        <div role="listbox" aria-label="Options" className="flex flex-col">
          {options.map((option, index) => (
            <button
              key={option.label}
              type="button"
              role="option"
              aria-selected={index === selected}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => (question?.multiSelect ? togglePick(index) : accept(index))}
              className={cn(
                "flex items-center gap-3 rounded-md px-2 py-1.5 text-start",
                index === selected && "bg-accent",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block">
                  {index === recommended
                    ? option.label.replace(RECOMMENDED_LABEL, "").trim()
                    : option.label}
                </span>
                {option.description && option.description !== option.label ? (
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                ) : null}
                {option.warning ? (
                  <span className="flex items-center gap-1 text-xs text-warning-foreground">
                    <TriangleAlertIcon className="size-3 shrink-0" />
                    {option.warning}
                  </span>
                ) : null}
              </span>
              {question?.multiSelect && picked.includes(optionValue(index) ?? "") ? (
                <CheckIcon aria-label="Picked" className="size-4" />
              ) : null}
              {index === recommended ? (
                <span className="text-xs text-muted-foreground">Recommended</span>
              ) : null}
              {index === selected ? <Kbd>E</Kbd> : null}
            </button>
          ))}
        </div>
      ) : wantsSuggestions && suggestions !== null ? (
        <p className="text-muted-foreground">
          {suggestionsFailed ? "Couldn't write suggestions." : "No suggestions."} Press R to write
          your own.
        </p>
      ) : null}
      {replying ? (
        <Textarea
          autoFocus
          value={reply}
          onFocus={(event) => {
            const end = event.currentTarget.value.length;
            event.currentTarget.setSelectionRange(end, end);
          }}
          placeholder="Your answer. Enter sends, Esc cancels."
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setReplying(false);
              setReply("");
            } else if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229
            ) {
              event.preventDefault();
              sendReply();
            }
          }}
        />
      ) : null}
      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>1</Kbd>–<Kbd>9</Kbd> jump
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> choose
        </span>
        {question?.multiSelect ? (
          <span className="flex items-center gap-1">
            <Kbd>Space</Kbd> pick
          </span>
        ) : null}
        <InlineButton tone="muted" onClick={() => accept(selected)}>
          <Kbd>E</Kbd> accept
        </InlineButton>
        {replying ? (
          <InlineButton tone="muted" onClick={sendReply}>
            <Kbd>Enter</Kbd> send
          </InlineButton>
        ) : (
          <InlineButton tone="muted" onClick={startReply}>
            <Kbd>R</Kbd> reply
          </InlineButton>
        )}
        <InlineButton tone="muted" onClick={snooze}>
          <Kbd>⌫</Kbd> snooze 15m
        </InlineButton>
        <InlineButton tone="muted" onClick={dismiss}>
          <Kbd>Esc</Kbd> dismiss
        </InlineButton>
        <InlineButton tone="muted" onClick={openThread}>
          <Kbd>O</Kbd> open thread
        </InlineButton>
      </footer>
    </section>
  );
}
