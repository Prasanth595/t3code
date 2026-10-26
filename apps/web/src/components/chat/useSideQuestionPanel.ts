import type {
  EnvironmentId,
  ProviderAskSideQuestionInput,
  ProviderAskSideQuestionResult,
  RunId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { SIDE_QUESTION_COMMAND, sideQuestionForkDraft } from "@t3tools/shared/sideQuestion";
import { useState } from "react";
import { create } from "zustand";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { newMessageId } from "~/lib/utils";
import type { SideQuestionExchange, SideQuestionPanelState } from "./ComposerSideQuestion";

interface StoredSideQuestionPanel {
  readonly state: SideQuestionPanelState;
  readonly hidden: boolean;
}

// Each thread keeps its panel in memory, so leaving a thread and coming back
// finds the answers, including one that arrived while you were away.
const useSideQuestionPanels = create<Readonly<Record<string, StoredSideQuestionPanel>>>(() => ({}));

function updatePanel(
  threadKey: string,
  update: (current: StoredSideQuestionPanel | undefined) => StoredSideQuestionPanel | undefined,
): void {
  useSideQuestionPanels.setState((panels) => {
    const next = update(panels[threadKey]);
    return next === undefined || next === panels[threadKey]
      ? panels
      : { ...panels, [threadKey]: next };
  });
}

export function resetSideQuestionPanelsForTests(): void {
  useSideQuestionPanels.setState({}, true);
}

function answeredExchanges(exchanges: ReadonlyArray<SideQuestionExchange>) {
  return exchanges.filter(
    (exchange): exchange is SideQuestionExchange & { answer: string } => exchange.answer !== null,
  );
}

export function useSideQuestionPanel(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly threadKey: string;
  readonly providerSlashCommands: ServerProvider["slashCommands"] | null;
  readonly ask: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: ProviderAskSideQuestionInput;
  }) => Promise<AtomCommandResult<ProviderAskSideQuestionResult, unknown>>;
  readonly forkRunId: RunId | null;
}) {
  const { environmentId, threadId, threadKey, providerSlashCommands, ask, forkRunId } = input;
  const stored = useSideQuestionPanels((panels) => panels[threadKey]);
  // Only an ask focuses the panel. Returning to a thread leaves focus in the composer.
  const [focusThreadKey, setFocusThreadKey] = useState<string | null>(null);
  if (focusThreadKey !== null && focusThreadKey !== threadKey) {
    setFocusThreadKey(null);
  }
  const offered =
    threadId !== null &&
    providerSlashCommands?.some((command) => command.name === SIDE_QUESTION_COMMAND.name) === true;

  const dismiss = useStableCallback(() =>
    updatePanel(threadKey, (current) => current && { ...current, hidden: true }),
  );
  const askFromPanel = useStableCallback((question: string) => {
    if (!offered || threadId === null) return false;
    const asked = question.trim();
    const current = useSideQuestionPanels.getState()[threadKey];
    setFocusThreadKey(threadKey);
    if (!asked) {
      const focusKey = newMessageId();
      updatePanel(threadKey, () => ({
        hidden: false,
        state: {
          exchanges: [],
          requestId: null,
          error: null,
          ...current?.state,
          focusKey,
        },
      }));
      return true;
    }
    if (current !== undefined && current.state.requestId !== null) {
      updatePanel(threadKey, () => ({ ...current, hidden: false }));
      return false;
    }
    const settled = answeredExchanges(current?.state.exchanges ?? []);
    const requestId = newMessageId();
    updatePanel(threadKey, () => ({
      hidden: false,
      state: {
        focusKey: requestId,
        exchanges: [...settled, { id: requestId, question: asked, answer: null }],
        requestId,
        error: null,
      },
    }));
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
      updatePanel(threadKey, (panel) => {
        if (panel?.state.requestId !== requestId) return panel;
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          return {
            ...panel,
            state: {
              ...panel.state,
              requestId: null,
              error: error instanceof Error ? error.message : "The side question failed.",
            },
          };
        }
        return {
          ...panel,
          state: {
            ...panel.state,
            requestId: null,
            exchanges: [...settled, { id: requestId, question: asked, ...result.value }],
          },
        };
      });
    });
    return true;
  });
  const forkInput = useStableCallback(() => {
    const panel = useSideQuestionPanels.getState()[threadKey]?.state;
    if (
      threadId === null ||
      forkRunId === null ||
      panel === undefined ||
      panel.requestId !== null
    ) {
      return null;
    }
    const answered = answeredExchanges(panel.exchanges);
    if (answered.length === 0) return null;
    return {
      sourceThreadId: threadId,
      runId: forkRunId,
      draftPrompt: sideQuestionForkDraft(answered),
    };
  });
  return {
    panel: stored === undefined || stored.hidden ? null : stored.state,
    autoFocus: focusThreadKey === threadKey,
    offered,
    ask: askFromPanel,
    dismiss,
    forkInput,
  };
}
