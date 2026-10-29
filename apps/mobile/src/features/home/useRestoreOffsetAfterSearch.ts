import { useEffect, useRef } from "react";

import type { WorkspaceSearchMode } from "../workspace/workspace-tabs-state";

/**
 * Restores a list's saved offset when search returns to resting. Mounting at rest restores
 * nothing: UIKit already rests the list below the header, and a scroll there would use an
 * unmeasured header inset.
 */
export function useRestoreOffsetAfterSearch(
  searchMode: WorkspaceSearchMode | undefined,
  savedOffset: number | undefined,
  restore: (offset: number) => void,
) {
  const previousSearchMode = useRef(searchMode);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the list to the offset saved when search opened once the tab returns to resting
  useEffect(() => {
    const restoringSearch = previousSearchMode.current !== "resting" && searchMode === "resting";
    previousSearchMode.current = searchMode;
    if (restoringSearch && savedOffset !== undefined) restore(savedOffset);
  }, [searchMode, savedOffset, restore]);
}
