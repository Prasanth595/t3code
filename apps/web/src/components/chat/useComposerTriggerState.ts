import { useRef, useState } from "react";

import { continueComposerPathTrigger } from "@t3tools/shared/composerTrigger";
import { detectComposerTrigger, type ComposerTrigger } from "../../composer-logic";

export function useComposerTriggerState(initialText: string, initialEnabled = true) {
  const [trigger, setActiveTrigger] = useState(() =>
    initialEnabled ? detectComposerTrigger(initialText, initialText.length) : null,
  );
  const previousSearchRef = useRef({ text: initialText, trigger });
  const dismissedTriggerRef = useRef<ComposerTrigger | null>(null);

  const detectTrigger = (text: string, cursor: number) => {
    const previous = previousSearchRef.current;
    const candidate =
      detectComposerTrigger(text, cursor) ??
      continueComposerPathTrigger(text, cursor, previous.trigger, previous.text);
    previousSearchRef.current = { text, trigger: candidate };
    return candidate;
  };

  const resolveTrigger = (candidate: ComposerTrigger | null) => {
    const dismissed = dismissedTriggerRef.current;
    return candidate &&
      dismissed &&
      candidate.kind === dismissed.kind &&
      candidate.rangeStart === dismissed.rangeStart
      ? null
      : candidate;
  };

  const setTrigger = (candidate: ComposerTrigger | null, text?: string) => {
    if (text !== undefined || candidate === null) {
      previousSearchRef.current = { text: text ?? "", trigger: candidate };
    }
    const activeTrigger = resolveTrigger(candidate);
    if (candidate === null || activeTrigger !== null) {
      dismissedTriggerRef.current = null;
    }
    setActiveTrigger(activeTrigger);
  };

  const dismissTrigger = (candidate: ComposerTrigger | null) => {
    dismissedTriggerRef.current = candidate;
    setActiveTrigger(null);
  };

  const resetTrigger = (candidate: ComposerTrigger | null, text: string) => {
    previousSearchRef.current = { text, trigger: candidate };
    dismissedTriggerRef.current = null;
    setActiveTrigger(candidate);
  };

  return { trigger, detectTrigger, setTrigger, resolveTrigger, dismissTrigger, resetTrigger };
}
