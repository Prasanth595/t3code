import { useRef, useState } from "react";

import { continueComposerPathTrigger } from "@t3tools/shared/composerTrigger";
import { detectComposerTrigger, type ComposerTrigger } from "../../composer-logic";

export function useComposerTriggerState(initialTrigger: () => ComposerTrigger | null) {
  const [trigger, setActiveTrigger] = useState(initialTrigger);
  const previousTriggerRef = useRef(trigger);
  const dismissedTriggerRef = useRef<ComposerTrigger | null>(null);

  const detectTrigger = (text: string, cursor: number) => {
    return (
      detectComposerTrigger(text, cursor) ??
      continueComposerPathTrigger(text, cursor, previousTriggerRef.current)
    );
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

  const setTrigger = (candidate: ComposerTrigger | null) => {
    previousTriggerRef.current = candidate;
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

  const resetTrigger = (candidate: ComposerTrigger | null) => {
    previousTriggerRef.current = candidate;
    dismissedTriggerRef.current = null;
    setActiveTrigger(candidate);
  };

  return { trigger, detectTrigger, setTrigger, resolveTrigger, dismissTrigger, resetTrigger };
}
