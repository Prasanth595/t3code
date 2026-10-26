import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

export interface SideQuestionExchange {
  readonly id: string;
  readonly question: string;
  readonly answer: string | null;
  readonly synthetic?: boolean;
}

export interface SideQuestionPanelState {
  readonly id: string;
  readonly focusKey: number;
  readonly exchanges: ReadonlyArray<SideQuestionExchange>;
  readonly pending: boolean;
  readonly error: string | null;
  readonly hidden: boolean;
}

// Each thread keeps its panel in memory, so coming back to a thread finds its
// answers, including one that arrived while you were away. A reload starts clean.
export const sideQuestionPanelsAtom = Atom.make<Readonly<Record<string, SideQuestionPanelState>>>(
  {},
).pipe(Atom.keepAlive, Atom.withLabel("mobile:side-question-panels"));

/** Applies `update` to the thread's panel. A null result leaves the panel as it was. */
export function updateSideQuestionPanel(
  threadKey: string,
  update: (current: SideQuestionPanelState | null) => SideQuestionPanelState | null,
): SideQuestionPanelState | null {
  const panels = appAtomRegistry.get(sideQuestionPanelsAtom);
  const current = panels[threadKey] ?? null;
  const next = update(current);
  if (next !== null && next !== current) {
    appAtomRegistry.set(sideQuestionPanelsAtom, { ...panels, [threadKey]: next });
  }
  return next;
}

export function beginSideQuestion(
  current: SideQuestionPanelState | null,
  id: string,
  question: string,
): SideQuestionPanelState | null {
  if (question.length === 0) {
    return current === null
      ? { id, focusKey: 0, exchanges: [], pending: false, error: null, hidden: false }
      : { ...current, focusKey: current.focusKey + 1, hidden: false };
  }
  if (current?.pending) return null;
  return {
    id: current?.id ?? id,
    focusKey: (current?.focusKey ?? 0) + 1,
    // Only answered exchanges carry over, so retrying a failed question
    // replaces it instead of stacking a copy.
    exchanges: [
      ...(current?.exchanges ?? []).filter((exchange) => exchange.answer !== null),
      { id, question, answer: null },
    ],
    pending: true,
    error: null,
    hidden: false,
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
