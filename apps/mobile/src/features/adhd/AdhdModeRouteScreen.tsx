import { useAtomValue } from "@effect/atom-react";
import {
  buildAdhdQueue,
  type AdhdCardKind,
  type AdhdQueueEntry,
} from "@t3tools/client-runtime/state/adhd-queue";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { PendingUserInputAnswer } from "@t3tools/client-runtime/state/pending-user-input";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  MessageId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { useProjects, useThreadShells } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { readEnvironmentScope } from "../../state/session";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadListActions } from "../home/useThreadListActions";
import { resolveThreadListV2Status, threadHasUnseenCompletion } from "../threads/threadListV2";
import { useThreadListNow } from "../threads/use-thread-list-now";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

const SNOOZE_MS = 15 * 60_000;
const RECOMMENDED_LABEL = /\(recommended\)/i;

const KIND_LABEL: Record<AdhdCardKind, { label: string; className: string }> = {
  approval: { label: "Approval", className: "text-warning-foreground" },
  input: { label: "Input", className: "text-adaptive-indigo-600-300" },
  failed: { label: "Failed", className: "text-danger-foreground" },
  done: { label: "Done", className: "text-adaptive-emerald-700-300" },
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

const threadKeyOf = (entry: AdhdQueueEntry) =>
  scopedThreadKey(scopeThreadRef(entry.thread.environmentId, entry.thread.id));

export function AdhdModeRouteScreen() {
  const insets = useSafeAreaInsets();
  const threads = useThreadShells();
  const projects = useProjects();
  const now = useThreadListNow(threads);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const projectKeys = projects.map((project) => `${project.environmentId}:${project.id}`);
  const projectNames = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
  );
  const queue = buildAdhdQueue({
    threads: threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        // Subagents hide under their parent, but a question of theirs needs its own card.
        (thread.lineage.relationshipToParent !== "subagent" ||
          thread.hasPendingApprovals ||
          thread.hasPendingUserInput),
    ),
    lastVisitedAt: (thread) => thread.lastVisitedAt ?? undefined,
    status: resolveThreadListV2Status,
    hasUnseenCompletion: (thread, lastVisitedAt) =>
      threadHasUnseenCompletion({ ...thread, lastVisitedAt }),
    projectOrder: projectKeys,
    now,
  });
  // An answered card leaves the queue, so the next one takes its place.
  const currentIndex = Math.max(
    0,
    queue.findIndex((entry) => threadKeyOf(entry) === selectedKey),
  );
  const current = queue[currentIndex] ?? null;
  // Pin the shown card, so a newly urgent thread can't swap it under a tap.
  if (current !== null && selectedKey !== threadKeyOf(current)) {
    setSelectedKey(threadKeyOf(current));
  }
  const workingCount = threads.filter(
    (thread) => thread.archivedAt === null && resolveThreadListV2Status(thread) === "working",
  ).length;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      className="flex-1"
      contentContainerClassName="gap-4 px-4 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
      {current === null ? (
        <EmptyState
          variant="plain"
          title="Nothing needs you"
          detail={
            workingCount > 0
              ? `${workingCount} agent${workingCount === 1 ? " is" : "s are"} working. They show up here when they stop.`
              : "Agents show up here when they stop and need you."
          }
        />
      ) : (
        <>
          <View className="flex-row flex-wrap items-center gap-2">
            {queue.map((entry, index) => (
              <Pressable
                key={threadKeyOf(entry)}
                accessibilityRole="button"
                accessibilityLabel={`Card ${index + 1}: ${entry.thread.title}`}
                accessibilityState={{ selected: index === currentIndex }}
                onPress={() => setSelectedKey(threadKeyOf(entry))}
                className={cn(
                  "size-8 items-center justify-center rounded-full border border-border",
                  index === currentIndex && "border-foreground bg-foreground",
                )}
              >
                <Text
                  className={cn(
                    "font-t3-medium text-xs",
                    index === currentIndex
                      ? "text-screen"
                      : entry.urgent
                        ? "text-danger-foreground"
                        : "text-foreground-muted",
                  )}
                >
                  {index + 1}
                </Text>
              </Pressable>
            ))}
            {workingCount > 0 ? (
              <Text className="text-xs text-foreground-muted">{workingCount} working, hidden</Text>
            ) : null}
          </View>
          <AdhdCard
            key={threadKeyOf(current)}
            entry={current}
            projectName={projectNames.get(
              `${current.thread.environmentId}:${current.thread.projectId}`,
            )}
            now={now}
          />
        </>
      )}
    </ScrollView>
  );
}

function AdhdCard(props: { entry: AdhdQueueEntry; projectName: string | undefined; now: string }) {
  const { entry } = props;
  const { thread } = entry;
  const ref = { environmentId: thread.environmentId, threadId: thread.id };
  const selectDetail = useSelectWorkspaceDetail();
  const pending = useAtomValue(environmentThreadDetails.pendingRequestsAtom(ref));
  const turnItems = useAtomValue(environmentThreadDetails.visibleTurnItemsAtom(ref));
  const { settleThread, snoozeThread } = useThreadListActions();
  const respondToApproval = useAtomCommand(
    threadEnvironment.respondToApproval,
    "thread approval response",
  );
  const respondToUserInput = useAtomCommand(
    threadEnvironment.respondToUserInput,
    "thread user input response",
  );
  const suggestNextPrompts = useAtomCommand(orchestrationEnvironment.suggestNextPrompts, {
    reportFailure: false,
  });
  const canOperate = readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const wantsSuggestions = entry.kind === "done" || entry.kind === "failed";

  const [suggestions, setSuggestions] = useState<ReadonlyArray<string> | null>(null);
  const [suggestionsFailed, setSuggestionsFailed] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The outbox resolves on enqueue, before the thread turns working and leaves the queue.
  const [promptQueued, setPromptQueued] = useState(false);
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

  const approval = entry.kind === "approval" ? (pending?.approvals[0] ?? null) : null;
  const userInput = entry.kind === "input" ? (pending?.userInputs[0] ?? null) : null;
  // Progress belongs to one request; a follow-up request on the same thread starts over.
  const requestProgress =
    userInput !== null && progress?.requestId === userInput.requestId ? progress : null;
  const questionIndex = requestProgress?.index ?? 0;
  const picked = requestProgress?.picked ?? [];
  const question = userInput?.questions[questionIndex] ?? null;
  // A question's own default answer starts as the draft, so a tweak is a small edit.
  const reply = draft ?? question?.initialAnswer ?? "";

  const approvalOptions = approval?.options ?? APPROVAL_OPTIONS;
  const options: ReadonlyArray<{ label: string; description?: string; warning?: string }> =
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

  const lastAssistant = turnItems.findLast(
    (item) => item.item.type === "assistant_message" && item.item.text.trim().length > 0,
  )?.item;
  const summary = lastAssistant?.type === "assistant_message" ? lastAssistant.text : null;

  const run = async (action: () => Promise<{ readonly _tag: string }>) => {
    if (busy || promptQueued || !canOperate) return false;
    setBusy(true);
    const result = await action();
    setBusy(false);
    return result._tag === "Success";
  };

  const sendPrompt = (text: string) =>
    run(async () => {
      const metadata = makeQueuedMessageMetadata();
      // The outbox delivers when the environment is reachable, like the composer's sends.
      const queued = await enqueueThreadOutboxMessage({
        environmentId: thread.environmentId,
        threadId: thread.id,
        messageId: MessageId.make(metadata.messageId),
        commandId: CommandId.make(metadata.commandId),
        text,
        attachments: [],
        createdAt: metadata.createdAt,
      }).then(
        () => true,
        () => false,
      );
      if (queued) setPromptQueued(true);
      else Dialog.alert("Could not send the message", "Try again from the thread.");
      return { _tag: queued ? "Success" : "Failure" };
    });

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
      setDraft(null);
      return true;
    }
    return run(() =>
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

  const choose = (index: number) => {
    const option = options[index];
    if (option === undefined) return;
    if (entry.kind === "approval") {
      if (approval === null || approval.responseCapability !== "live") return;
      const decision: ProviderApprovalDecision = approvalOptions[index]!.decision;
      void run(() =>
        respondToApproval({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, requestId: approval.requestId, decision },
        }),
      );
    } else if (entry.kind === "input") {
      const value = optionValue(index);
      if (value === null || userInput === null) return;
      if (question?.multiSelect) {
        setProgress({
          requestId: userInput.requestId,
          index: questionIndex,
          answers: requestProgress?.answers ?? {},
          picked: picked.includes(value)
            ? picked.filter((item) => item !== value)
            : [...picked, value],
        });
        return;
      }
      void answerQuestion(value);
    } else {
      void sendPrompt(option.label);
    }
  };

  const canReply =
    entry.kind === "approval"
      ? approval?.supportsFeedback === true
      : entry.kind === "input"
        ? question?.allowCustomAnswer !== false
        : true;
  const sendReply = () => {
    // A question's own default answer is sent as written, even when cleared on purpose.
    const keepsRawAnswer = entry.kind === "input" && question?.initialAnswer !== undefined;
    const text = keepsRawAnswer ? reply : reply.trim();
    if (text.length === 0 && !keepsRawAnswer) return;
    // The draft stays until the send goes through, so a failed send can be retried.
    const clearOnSuccess = (sent: boolean) => {
      if (sent) setDraft(null);
    };
    if (entry.kind === "approval") {
      if (approval === null || approval.responseCapability !== "live") return;
      void run(() =>
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
      void answerQuestion(text).then(clearOnSuccess);
    } else {
      void sendPrompt(text).then(clearOnSuccess);
    }
  };

  const snooze = () => {
    if (!canSnooze(thread, { now: props.now })) {
      Dialog.alert(
        "Answer it first",
        "A thread can't be snoozed while the agent is waiting on you.",
      );
      return;
    }
    void snoozeThread(thread, new Date(Date.parse(props.now) + SNOOZE_MS).toISOString());
  };

  const openThread = () =>
    selectDetail({
      name: "Thread",
      params: { environmentId: thread.environmentId, threadId: thread.id },
    });

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
    <View
      accessibilityLabel={thread.title}
      className={cn(
        "gap-4 rounded-[20px] border border-border bg-card-alt p-4",
        busy && "opacity-60",
      )}
    >
      <View className="gap-1">
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          <Text className={cn("font-t3-bold text-xs", kind.className)}>{kind.label}</Text>
          {props.projectName ? ` · ${props.projectName}` : ""}
        </Text>
        <Text className="font-t3-bold text-lg text-foreground" numberOfLines={2}>
          {thread.title}
        </Text>
      </View>
      {wantsSuggestions && summary ? (
        <Text
          className="font-sans text-sm leading-normal text-foreground-secondary"
          numberOfLines={6}
        >
          {summary}
        </Text>
      ) : null}
      <Text className="font-sans text-base leading-normal text-foreground">{prompt}</Text>
      {approval?.detail ? (
        <Text className="rounded-xl bg-subtle px-3 py-2 font-mono text-xs text-foreground-secondary">
          {approval.detail}
        </Text>
      ) : null}
      {userInput !== null && userInput.questions.length > 1 ? (
        <Text className="text-xs text-foreground-muted">
          Question {questionIndex + 1} of {userInput.questions.length}
        </Text>
      ) : null}
      {!canOperate ? (
        <Text className="font-sans text-sm text-foreground-muted">
          {wantsSuggestions
            ? "Suggestions need permission to operate this environment."
            : "This connection cannot answer the agent."}
        </Text>
      ) : wantsSuggestions && suggestions === null ? (
        <Text className="font-sans text-sm text-foreground-muted">Thinking of next steps…</Text>
      ) : wantsSuggestions && options.length === 0 ? (
        <Text className="font-sans text-sm text-foreground-muted">
          {suggestionsFailed
            ? "Couldn't suggest a next step. Write your own below."
            : "No suggestion. Write your own below."}
        </Text>
      ) : null}
      {options.length > 0 ? (
        <View className="gap-2">
          {options.map((option, index) => {
            const value = entry.kind === "input" ? optionValue(index) : null;
            const isPicked = value !== null && picked.includes(value);
            return (
              <Pressable
                key={option.label}
                accessibilityRole={question?.multiSelect ? "checkbox" : "button"}
                accessibilityState={{
                  disabled: busy || promptQueued || !canOperate,
                  ...(question?.multiSelect ? { checked: isPicked } : {}),
                }}
                disabled={busy || promptQueued || !canOperate}
                onPress={() => choose(index)}
                className={cn(
                  "flex-row gap-3 rounded-2xl border border-border px-3 py-3 active:opacity-70",
                  (index === recommended || isPicked) && "border-foreground-muted bg-subtle",
                )}
              >
                {isPicked ? (
                  <SymbolView
                    name="checkmark.circle.fill"
                    size={16}
                    tintColorClassName="accent-foreground"
                  />
                ) : (
                  <Text className="w-4 font-t3-medium text-sm text-foreground-muted">
                    {index + 1}
                  </Text>
                )}
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="font-t3-medium text-sm text-foreground">{option.label}</Text>
                  {option.description ? (
                    <Text className="text-xs leading-normal text-foreground-muted">
                      {option.description}
                    </Text>
                  ) : null}
                  {option.warning ? (
                    <Text className="text-xs leading-normal text-warning-foreground">
                      {option.warning}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {question?.multiSelect ? (
        <Button
          tone="primary"
          label={picked.length > 0 ? `Send ${picked.length} picked` : "Pick one or more"}
          disabled={picked.length === 0 || busy || !canOperate}
          onPress={() => void answerQuestion(picked)}
        />
      ) : null}
      {canReply && canOperate ? (
        <View className="gap-2">
          <TextInput
            accessibilityLabel="Your own answer"
            value={reply}
            onChangeText={setDraft}
            multiline
            textAlignVertical="top"
            placeholder={
              entry.kind === "approval"
                ? "Decline and tell the agent what to do instead"
                : "Write your own"
            }
            placeholderTextColorClassName="accent-foreground-muted"
            className="max-h-40 min-h-16 rounded-2xl border border-border px-3 py-2 font-sans text-base text-foreground"
          />
          {reply.trim().length > 0 ||
          (entry.kind === "input" && question?.initialAnswer !== undefined) ? (
            <Button
              tone="primary"
              label="Send"
              disabled={busy || promptQueued}
              onPress={sendReply}
            />
          ) : null}
        </View>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <Button label="Snooze 15 min" icon="calendar.badge.clock" onPress={snooze} />
        <Button label="Dismiss" icon="checkmark.circle" onPress={() => void settleThread(thread)} />
        <Button label="Open" icon="arrow.up.right" onPress={openThread} />
      </View>
    </View>
  );
}
