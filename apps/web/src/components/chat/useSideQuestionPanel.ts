import type {
  EnvironmentId,
  ProviderAskSideQuestionInput,
  ProviderAskSideQuestionResult,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { SIDE_QUESTION_COMMAND } from "@t3tools/shared/sideQuestion";
import { useLayoutEffect, useRef, useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { newMessageId } from "~/lib/utils";
import type { SideQuestionPanelState } from "./ComposerSideQuestion";

export function useSideQuestionPanel(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly threadKey: string;
  readonly providerSlashCommands: ServerProvider["slashCommands"] | null;
  readonly ask: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: ProviderAskSideQuestionInput;
  }) => Promise<AtomCommandResult<ProviderAskSideQuestionResult, unknown>>;
}) {
  const { environmentId, threadId, threadKey, providerSlashCommands, ask } = input;
  const [panel, setPanel] = useState<SideQuestionPanelState | null>(null);
  const requestRef = useRef<{ threadKey: string; id: string } | null>(null);
  useLayoutEffect(() => {
    if (requestRef.current?.threadKey !== threadKey) requestRef.current = null;
  }, [threadKey]);
  if (panel !== null && panel.threadKey !== threadKey) {
    setPanel(null);
  }
  const offered =
    threadId !== null &&
    providerSlashCommands?.some((command) => command.name === SIDE_QUESTION_COMMAND.name) === true;

  const dismiss = useStableCallback(() => {
    requestRef.current = null;
    setPanel(null);
  });
  const askFromPanel = useStableCallback((question: string) => {
    if (!offered || threadId === null) return false;
    const asked = question.trim();
    if (!asked) {
      const focusKey = newMessageId();
      setPanel((current) => ({
        threadKey,
        exchanges: [],
        requestId: null,
        error: null,
        ...(current?.threadKey === threadKey ? current : {}),
        focusKey,
      }));
      return true;
    }
    if (requestRef.current !== null) return false;
    const settled = (panel?.exchanges ?? []).filter(
      (exchange): exchange is typeof exchange & { answer: string } => exchange.answer !== null,
    );
    const requestId = newMessageId();
    requestRef.current = { threadKey, id: requestId };
    setPanel({
      threadKey,
      focusKey: requestId,
      exchanges: [...settled, { id: requestId, question: asked, answer: null }],
      requestId,
      error: null,
    });
    void ask({
      environmentId,
      input: {
        threadId,
        question: asked,
        history: settled.map((exchange) => ({
          question: exchange.question,
          response: exchange.answer,
        })),
      },
    }).then((result) => {
      if (requestRef.current?.id === requestId) requestRef.current = null;
      setPanel((current) => {
        if (current?.requestId !== requestId) return current;
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          return {
            ...current,
            requestId: null,
            error: error instanceof Error ? error.message : "The side question failed.",
          };
        }
        return {
          ...current,
          requestId: null,
          exchanges: [...settled, { id: requestId, question: asked, ...result.value }],
        };
      });
    });
    return true;
  });
  return { panel, offered, ask: askFromPanel, dismiss };
}
