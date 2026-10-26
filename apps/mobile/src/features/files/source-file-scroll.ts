interface SourceLineList {
  readonly props: { readonly data?: { readonly length: number } | null };
  scrollToIndex(params: { index: number; animated: boolean; viewPosition: number }): void;
  scrollToOffset(params: { offset: number; animated: boolean }): void;
}

const RETRY_DELAY_MS = 100;
const MAX_RETRIES = 5;

// Wrapped rows have no getItemLayout. VirtualizedList fails a jump past its highest measured
// row and silently estimates an unmeasured row below it, so re-aim until the budget runs out.
export function createSourceLineScroll(getList: () => SourceLineList | null) {
  let target: number | null = null;
  let retries = 0;
  let cancelPending: (() => void) | null = null;

  const cancel = () => {
    cancelPending?.();
    cancelPending = null;
    target = null;
  };

  const retry = () => {
    if (retries >= MAX_RETRIES) {
      target = null;
      return;
    }
    retries += 1;
    const timer = setTimeout(attempt, RETRY_DELAY_MS);
    cancelPending = () => clearTimeout(timer);
  };

  const attempt = () => {
    cancelPending = null;
    const list = getList();
    if (target === null || !list || target >= (list.props.data?.length ?? 0)) {
      target = null;
      return;
    }
    list.scrollToIndex({ index: target, animated: false, viewPosition: 0.3 });
    // A failed jump has already scheduled its retry.
    if (cancelPending === null) retry();
  };

  return {
    scrollToLine(index: number) {
      cancel();
      if (!Number.isInteger(index) || index < 0) return;
      target = index;
      retries = 0;
      const frame = requestAnimationFrame(attempt);
      cancelPending = () => cancelAnimationFrame(frame);
    },
    onScrollToIndexFailed(info: {
      index: number;
      averageItemLength: number;
      highestMeasuredFrameIndex: number;
    }) {
      const list = getList();
      if (info.index !== target || !list) return;
      list.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
      retry();
    },
    cancel,
  };
}
