import { FileDiff } from "@pierre/diffs/react";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import {
  buildReviewCommentRenderablePatch,
  type ReviewCommentContext,
} from "../../reviewCommentContext";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";

export default function ReviewCommentDiff({
  comment,
  theme,
}: {
  comment: ReviewCommentContext;
  theme: "light" | "dark";
}) {
  const renderablePatch = getRenderablePatch(
    buildReviewCommentRenderablePatch(comment),
    `review-comment:${comment.id}`,
  );

  if (renderablePatch?.kind === "files") {
    return (
      <DiffWorkerPoolProvider>
        {renderablePatch.files.map((fileDiff) => (
          <FileDiff
            key={resolveFileDiffPath(fileDiff)}
            fileDiff={fileDiff}
            options={{
              collapsed: false,
              diffStyle: "unified",
              theme: resolveDiffThemeName(theme),
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
            }}
          />
        ))}
      </DiffWorkerPoolProvider>
    );
  }
  return renderablePatch?.kind === "raw" ? (
    <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">{renderablePatch.text}</pre>
  ) : null;
}
