export interface SideQuestionExchange {
  readonly id: string;
  readonly question: string;
  readonly answer: string | null;
  readonly synthetic?: boolean;
}

export interface SideQuestionPanelState {
  readonly id: string;
  readonly threadKey: string;
  readonly focusKey: number;
  readonly exchanges: ReadonlyArray<SideQuestionExchange>;
  readonly pending: boolean;
  readonly error: string | null;
}

export function beginSideQuestion(
  current: SideQuestionPanelState | null,
  threadKey: string,
  id: string,
  question: string,
): SideQuestionPanelState | null {
  const same = current?.threadKey === threadKey ? current : null;
  if (question.length === 0) {
    return same === null
      ? { id, threadKey, focusKey: 0, exchanges: [], pending: false, error: null }
      : { ...same, focusKey: same.focusKey + 1 };
  }
  if (same?.pending) return null;
  return {
    id: same?.id ?? id,
    threadKey,
    focusKey: same?.focusKey ?? 0,
    // Only answered exchanges carry over, so retrying a failed question
    // replaces it instead of stacking a copy.
    exchanges: [
      ...(same?.exchanges ?? []).filter((exchange) => exchange.answer !== null),
      { id, question, answer: null },
    ],
    pending: true,
    error: null,
  };
}

export function finishSideQuestion(
  current: SideQuestionPanelState | null,
  id: string,
  result: { readonly answer: string; readonly synthetic?: boolean } | { readonly error: string },
): SideQuestionPanelState | null {
  if (!current?.pending || current.exchanges.at(-1)?.id !== id) return current;
  return {
    ...current,
    pending: false,
    error: "error" in result ? result.error : null,
    exchanges: current.exchanges.map((exchange) =>
      exchange.id !== id || "error" in result ? exchange : { ...exchange, ...result },
    ),
  };
}
