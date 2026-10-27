export const THREAD_HISTORY_PULL_DISTANCE = 96;

interface ThreadHistoryPullState {
  readonly startOffset: number | null;
  readonly progress: number;
  readonly loadEarlier: boolean;
}

type ThreadHistoryPullEvent =
  | { readonly type: "start"; readonly offset: number }
  | { readonly type: "move"; readonly translationY: number; readonly offset: number }
  | { readonly type: "release" }
  | { readonly type: "cancel" };

export const INITIAL_THREAD_HISTORY_PULL: ThreadHistoryPullState = {
  startOffset: null,
  progress: 0,
  loadEarlier: false,
};

export function reduceThreadHistoryPull(
  state: ThreadHistoryPullState,
  event: ThreadHistoryPullEvent,
): ThreadHistoryPullState {
  "worklet";
  switch (event.type) {
    case "start":
      return { startOffset: Math.max(0, event.offset), progress: 0, loadEarlier: false };
    case "move":
      return {
        ...state,
        progress:
          state.startOffset === null || event.offset > 1
            ? 0
            : Math.min(
                1,
                Math.max(
                  0,
                  (event.translationY - state.startOffset) / THREAD_HISTORY_PULL_DISTANCE,
                ),
              ),
        loadEarlier: false,
      };
    case "release":
      return { ...INITIAL_THREAD_HISTORY_PULL, loadEarlier: state.progress >= 1 };
    case "cancel":
      return INITIAL_THREAD_HISTORY_PULL;
  }
}
