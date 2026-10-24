import type { RouterHistory } from "@tanstack/react-router";

export function createNavigationHistoryStore(history: RouterHistory, forwardEntries = 0) {
  // Browser history.length includes pages outside T3, so only offer Forward
  // for entries known to belong to this app.
  let lastIndex = history.location.state.__TSR_index + forwardEntries;
  const readSnapshot = () => ({
    canGoBack: history.canGoBack(),
    canGoForward: history.location.state.__TSR_index < lastIndex,
  });
  let snapshot = readSnapshot();
  const getSnapshot = () => {
    lastIndex = Math.max(lastIndex, history.location.state.__TSR_index);
    const next = readSnapshot();
    if (next.canGoBack !== snapshot.canGoBack || next.canGoForward !== snapshot.canGoForward) {
      snapshot = next;
    }
    return snapshot;
  };

  return {
    getSnapshot,
    subscribe: (onChange: () => void) => {
      getSnapshot();
      return history.subscribe(({ location, action }) => {
        if (action.type === "PUSH") lastIndex = location.state.__TSR_index;
        const previous = snapshot;
        if (getSnapshot() !== previous) onChange();
      });
    },
  };
}
