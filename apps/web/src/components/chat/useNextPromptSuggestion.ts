import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useAtomCommand } from "~/state/use-atom-command";

import type { ChatMessage, SessionPhase } from "../../types";
import { latestSettledReplyId, nextPromptRequestTarget } from "./useNextPromptSuggestion.logic";

/**
 * The draft the user is likely to write after the agent's latest reply. It lives in this
 * component's memory only and is dropped as soon as the thread moves on.
 */
export function useNextPromptSuggestion(input: {
  readonly environmentId: EnvironmentId | undefined;
  readonly threadId: ThreadId | null;
  readonly enabled: boolean;
  readonly phase: SessionPhase;
  readonly messages: ReadonlyArray<ChatMessage>;
}) {
  const { environmentId, threadId, enabled, phase, messages } = input;
  const canSuggest = useAtomValue(
    orchestrationEnvironment.suggestNextPrompt.permissionAtom(environmentId ?? null),
  );
  const suggestNextPrompt = useStableCallback(
    useAtomCommand(orchestrationEnvironment.suggestNextPrompt, {
      reportFailure: false,
      reportDefect: false,
    }),
  );
  const [result, setResult] = useState<{
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly replyId: MessageId;
    readonly text: string;
  } | null>(null);
  const [dismissedReplyId, setDismissedReplyId] = useState<MessageId | null>(null);
  const watchedRunningThreadId = useRef<ThreadId | null>(null);
  const context = useRef({ environmentId, threadId });
  const request = useRef<{
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly replyId: MessageId;
    readonly answer: ReturnType<typeof suggestNextPrompt>;
  } | null>(null);
  const replyId = latestSettledReplyId(messages);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the suggestion RPC for the watched reply and detaches stale response listeners
  useEffect(() => {
    if (context.current.environmentId !== environmentId || context.current.threadId !== threadId) {
      watchedRunningThreadId.current = null;
      request.current = null;
      context.current = { environmentId, threadId };
    }
    if (!enabled || !canSuggest || phase !== "ready" || request.current?.replyId !== replyId) {
      request.current = null;
    }
    if (threadId === null) return;
    if (phase === "running") {
      watchedRunningThreadId.current = threadId;
      return;
    }
    const target = nextPromptRequestTarget({
      phase,
      threadId,
      watchedRunningThreadId: watchedRunningThreadId.current,
      replyId,
    });
    if (phase === "ready") watchedRunningThreadId.current = null;
    if (!enabled || !canSuggest || environmentId === undefined) return;
    if (request.current === null && target !== null) {
      request.current = {
        environmentId,
        threadId,
        replyId: target,
        answer: suggestNextPrompt({ environmentId, input: { threadId, afterMessageId: target } }),
      };
    }
    const pending = request.current;
    if (pending === null) return;
    let current = true;
    void pending.answer.then((answer) => {
      if (
        !current ||
        request.current !== pending ||
        answer._tag !== "Success" ||
        answer.value.suggestion === null
      )
        return;
      setResult({
        environmentId,
        threadId,
        replyId: pending.replyId,
        text: answer.value.suggestion,
      });
    });
    return () => {
      current = false;
    };
  }, [environmentId, threadId, phase, replyId, enabled, canSuggest, suggestNextPrompt]);

  if (
    result !== null &&
    (!enabled ||
      !canSuggest ||
      phase !== "ready" ||
      result.environmentId !== environmentId ||
      result.threadId !== threadId ||
      result.replyId !== replyId)
  ) {
    setResult(null);
  }

  const visible =
    enabled &&
    canSuggest &&
    result !== null &&
    result.environmentId === environmentId &&
    result.threadId === threadId &&
    result.replyId === replyId &&
    dismissedReplyId !== replyId &&
    phase === "ready";

  return {
    suggestion: visible ? result.text : null,
    dismiss: () => setDismissedReplyId(replyId),
  };
}
