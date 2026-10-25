interface SourceLineList {
  readonly props: { readonly data?: { readonly length: number } | null };
  scrollToIndex(params: { index: number; animated: boolean; viewPosition: number }): void;
  scrollToOffset(params: { offset: number; animated: boolean }): void;
}

const RETRY_DELAY_MS = 100;
const MAX_RETRIES = 5;

// Wrapped rows have no getItemLayout, so a jump past the rendered window fails until
// those rows measure. Jump to an averaged offset to render them, then retry.
export function createSourceLineScroll(getList: () => SourceLineList | null) {
  let target: number | null = null;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    target = null;
  };

  const attempt = () => {
    timer = null;
    const list = getList();
    if (target === null || !list || target >= (list.props.data?.length ?? 0)) {
      target = null;
      return;
    }
    list.scrollToIndex({ index: target, animated: false, viewPosition: 0.3 });
    // VirtualizedList reports failure synchronously, which schedules the next retry.
    if (timer === null) target = null;
  };

  return {
    scrollToLine(index: number) {
      cancel();
      if (!Number.isInteger(index) || index < 0) return;
      target = index;
      retries = 0;
      attempt();
    },
    onScrollToIndexFailed(info: {
      index: number;
      averageItemLength: number;
      highestMeasuredFrameIndex: number;
    }) {
      const list = getList();
      if (info.index !== target || !list) return;
      list.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
      if (retries >= MAX_RETRIES) {
        target = null;
        return;
      }
      retries += 1;
      timer = setTimeout(attempt, RETRY_DELAY_MS);
    },
    cancel,
  };
}
