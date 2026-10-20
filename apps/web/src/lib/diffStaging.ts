import type { FileDiffMetadata } from "@pierre/diffs";
import type { ReviewDiffPreviewSource } from "@t3tools/contracts";

import { resolveFileDiffPath, resolveFileDiffPreviousPath } from "./diffRendering";

/** A rename stages or unstages both of its paths. */
export function fileDiffStagingPaths(fileDiff: FileDiffMetadata): string[] {
  return [...new Set([resolveFileDiffPath(fileDiff), resolveFileDiffPreviousPath(fileDiff)])];
}

/** Every path in a section, including files a truncated preview has not rendered. */
export function sourceStagingPaths(
  source: ReviewDiffPreviewSource,
  renderedFiles: ReadonlyArray<FileDiffMetadata>,
): string[] {
  const paths = source.files
    ? source.files.flatMap((file) => [file.path, ...(file.previousPath ? [file.previousPath] : [])])
    : renderedFiles.flatMap(fileDiffStagingPaths);
  return [...new Set(paths)];
}
