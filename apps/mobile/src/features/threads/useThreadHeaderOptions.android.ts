import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { usesFloatingThreadControls } from "./ThreadFloatingControls";
import type { useThreadHeaderOptions as useIosThreadHeaderOptions } from "./useThreadHeaderOptions";

export function useThreadHeaderOptions(
  props: Parameters<typeof useIosThreadHeaderOptions>[0],
): ReturnType<typeof useIosThreadHeaderOptions> {
  const { layout } = useAdaptiveWorkspaceLayout();
  // The floating pills draw their own controls over the feed, so the native
  // header stays hidden on the compact thread screen.
  const floatingControls = usesFloatingThreadControls(layout);
  return {
    options: {
      contentStyle: { backgroundColor: props.headerColor },
      ...(floatingControls ? { headerShown: false } : {}),
    },
    // Android renders header actions as children, not native item factories.
    optionsVersion: [],
    sidebar: true,
    fallback: null,
  };
}
