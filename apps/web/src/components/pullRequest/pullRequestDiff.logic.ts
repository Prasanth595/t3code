import type { FileDiffMetadata } from "@pierre/diffs";
import type { PullRequestDiffSide, PullRequestOmittedFileStat } from "@t3tools/contracts";

/**
 * A thread naming a file is not the same as a thread the diff can show: its line may have moved
 * out of the change, or sit in a hunk the host withheld. Pinning it anyway would put the remark
 * against whatever code now occupies that line number, and silently dropping it would lose the
 * conversation, so the answer decides which of the two lists it belongs in.
 */
export function isLineInFileDiff(
  file: FileDiffMetadata,
  side: PullRequestDiffSide,
  line: number,
): boolean {
  return file.hunks.some((hunk) =>
    side === "left"
      ? line >= hunk.deletionStart && line < hunk.deletionStart + hunk.deletionCount
      : line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount,
  );
}

export type DiffFoldOverride = "expanded" | "folded" | null;

/**
 * A diff arrives a slice at a time, so the reader's own choices are kept as the difference from
 * what the toolbar last said rather than as the set of folded files: a file that has not loaded
 * yet cannot be in a set, and would otherwise land expanded moments after the reader folded
 * everything.
 */
export function isFileDiffCollapsed(
  fileKey: string,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>,
): boolean {
  const foldedByDefault = foldOverride === "folded";
  return toggledFileKeys.has(fileKey) ? !foldedByDefault : foldedByDefault;
}

export function toggleFileDiffFoldForViewed(
  fileKey: string,
  viewed: boolean,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  if (isFileDiffCollapsed(fileKey, foldOverride, toggledFileKeys) === viewed)
    return toggledFileKeys;
  const next = new Set(toggledFileKeys);
  if (next.has(fileKey)) next.delete(fileKey);
  else next.add(fileKey);
  return next;
}

/** One answer from the host: a whole number of files, and where the next one carries on. */
export interface DiffSlice {
  /** What was asked for, null being the first slice. Identifies the slice among the loaded ones. */
  readonly cursor: string | null;
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats: ReadonlyArray<PullRequestOmittedFileStat>;
}

/**
 * Folds one answer into the loaded slices. A new cursor appends. An unchanged answer keeps every
 * slice and moves the cursor to the next loaded one, so a background refresh re-reads them in
 * turn. A changed answer replaces its slice and drops the ones after it.
 */
export function reconcileDiffSlices(
  slices: ReadonlyArray<DiffSlice>,
  answer: DiffSlice,
): { readonly cursor: string | null; readonly slices: ReadonlyArray<DiffSlice> } {
  const index = slices.findIndex((slice) => slice.cursor === answer.cursor);
  if (index === -1) return { cursor: answer.cursor, slices: [...slices, answer] };
  const existing = slices[index];
  if (existing !== undefined && isSameDiffSlice(existing, answer)) {
    return { cursor: slices[index + 1]?.cursor ?? answer.cursor, slices };
  }
  return { cursor: answer.cursor, slices: [...slices.slice(0, index), answer] };
}

function isSameDiffSlice(existing: DiffSlice, next: DiffSlice): boolean {
  return (
    existing.patch === next.patch &&
    existing.truncated === next.truncated &&
    existing.nextCursor === next.nextCursor &&
    existing.omittedFileStats.length === next.omittedFileStats.length &&
    existing.omittedFileStats.every((file, index) => {
      const refreshed = next.omittedFileStats[index];
      return (
        refreshed !== undefined &&
        refreshed.path === file.path &&
        refreshed.additions === file.additions &&
        refreshed.deletions === file.deletions
      );
    })
  );
}
