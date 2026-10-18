import type { useThreadHeaderOptions as useIosThreadHeaderOptions } from "./useThreadHeaderOptions";

export function useThreadHeaderOptions(
  props: Parameters<typeof useIosThreadHeaderOptions>[0],
): ReturnType<typeof useIosThreadHeaderOptions> {
  return {
    options: { contentStyle: { backgroundColor: props.headerColor } },
    // Android renders header actions as children, not native item factories.
    optionsVersion: [],
    titleMaxWidth: 0, // The Android app bar constrains its title content directly.
    sidebar: true,
    fallback: null,
  };
}
