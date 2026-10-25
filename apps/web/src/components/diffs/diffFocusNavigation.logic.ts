import type { FileDiffMetadata, SelectionSide } from "@pierre/diffs";

export interface DiffChangeTarget {
  readonly side: SelectionSide;
  readonly lineNumber: number;
}

export interface DiffFocusPosition {
  readonly fileIndex: number;
  /** -1 is the top of the file, before its first change. */
  readonly changeIndex: number;
}

export function diffChangeTargets(fileDiff: FileDiffMetadata): ReadonlyArray<DiffChangeTarget> {
  const targets: DiffChangeTarget[] = [];
  for (const hunk of fileDiff.hunks) {
    let additionLine = hunk.additionStart;
    let deletionLine = hunk.deletionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        additionLine += content.lines;
        deletionLine += content.lines;
        continue;
      }
      targets.push(
        content.additions > 0
          ? { side: "additions", lineNumber: additionLine }
          : { side: "deletions", lineNumber: deletionLine },
      );
      additionLine += content.additions;
      deletionLine += content.deletions;
    }
  }
  return targets;
}

export function stepDiffChange(
  position: DiffFocusPosition,
  changeCounts: ReadonlyArray<number>,
  delta: 1 | -1,
): DiffFocusPosition {
  let { fileIndex, changeIndex } = position;
  changeIndex += delta;
  while (fileIndex >= 0 && fileIndex < changeCounts.length) {
    const count = changeCounts[fileIndex] ?? 0;
    if (changeIndex >= 0 && changeIndex < count) return { fileIndex, changeIndex };
    fileIndex += delta;
    changeIndex = delta === 1 ? 0 : (changeCounts[fileIndex] ?? 0) - 1;
  }
  return position;
}
