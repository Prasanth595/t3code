import { useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";

export function useComposerFocusState() {
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [isComposerScrollCollapsed, setIsComposerScrollCollapsed] = useState(false);

  const restoreAfterTimelineReachedEnd = useStableCallback(() => {
    setIsComposerScrollCollapsed(false);
  });

  return {
    isComposerFocused,
    setIsComposerFocused,
    isComposerScrollCollapsed,
    setIsComposerScrollCollapsed,
    restoreAfterTimelineReachedEnd,
  };
}
