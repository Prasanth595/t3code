export type DiffFoldOverride = "expanded" | "folded" | null;

export interface DiffFilesCollapseState {
  readonly foldOverride: DiffFoldOverride;
  readonly toggledFileKeys: ReadonlySet<string>;
}

/** Keep file choices relative to the bulk choice so patches arriving later inherit it. */
export function isFileDiffCollapsed(
  fileKey: string,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>,
): boolean {
  const foldedByDefault = foldOverride === "folded";
  return toggledFileKeys.has(fileKey) ? !foldedByDefault : foldedByDefault;
}

export function setDiffFileCollapsed(
  fileKey: string,
  state: DiffFilesCollapseState,
  collapsed: boolean,
): DiffFilesCollapseState {
  if (isFileDiffCollapsed(fileKey, state.foldOverride, state.toggledFileKeys) === collapsed) {
    return state;
  }
  const toggledFileKeys = new Set(state.toggledFileKeys);
  if (toggledFileKeys.has(fileKey)) toggledFileKeys.delete(fileKey);
  else toggledFileKeys.add(fileKey);
  return { ...state, toggledFileKeys };
}

export function areAllDiffFilesCollapsed(
  fileKeys: ReadonlyArray<string>,
  collapsedFileKeys: ReadonlySet<string>,
): boolean {
  return fileKeys.length > 0 && fileKeys.every((fileKey) => collapsedFileKeys.has(fileKey));
}

export function toggleAllDiffFiles(
  fileKeys: ReadonlyArray<string>,
  state: DiffFilesCollapseState,
): DiffFilesCollapseState {
  const allCollapsed =
    fileKeys.length > 0 &&
    fileKeys.every((fileKey) =>
      isFileDiffCollapsed(fileKey, state.foldOverride, state.toggledFileKeys),
    );
  return {
    foldOverride: allCollapsed ? "expanded" : "folded",
    toggledFileKeys: new Set(),
  };
}
