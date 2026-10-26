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
    readonly threadId: ThreadId;
    readonly replyId: MessageId;
    readonly text: string;
  } | null>(null);
  const [dismissedReplyId, setDismissedReplyId] = useState<MessageId | null>(null);
  const watchedRunningThreadId = useRef<ThreadId | null>(null);
  const replyId = latestSettledReplyId(messages);

  // oxlint-disable-next-line t3code/react-effect-budget -- asks the server once per watched reply and drops the answer when the thread moves on
  useEffect(() => {
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
    if (target === null || !enabled || !canSuggest || environmentId === undefined) return;
    watchedRunningThreadId.current = null;
    let current = true;
    void suggestNextPrompt({
      environmentId,
      input: { threadId, afterMessageId: target },
    }).then((answer) => {
      if (!current || answer._tag !== "Success" || answer.value.suggestion === null) return;
      setResult({ threadId, replyId: target, text: answer.value.suggestion });
    });
    return () => {
      current = false;
    };
  }, [environmentId, threadId, phase, replyId, enabled, canSuggest, suggestNextPrompt]);

  const visible =
    result !== null &&
    result.threadId === threadId &&
    result.replyId === replyId &&
    dismissedReplyId !== replyId &&
    phase === "ready";

  return {
    suggestion: visible ? result.text : null,
    dismiss: () => setDismissedReplyId(replyId),
  };
}
