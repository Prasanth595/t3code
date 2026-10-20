import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import {
  pullRequestTarget as requestTarget,
  usePullRequestDiff,
  type PullRequestDiffParams,
} from "./usePullRequestDiff";
import { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";
import { usePullRequestFileFilter } from "./usePullRequestFileFilter";

/** Changed-file state shared by the overview section and the files sheet. */
export function usePullRequestFiles(params: PullRequestDiffParams) {
  const diff = usePullRequestDiff(params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(requestTarget(params)));
  const pr = params.commit ? null : detail.data;
  const viewed = usePullRequestFilesViewed(params, pr);
  const breakdown = useEnvironmentQuery(
    params.commit ? null : composerPullRequests.changeBreakdown(requestTarget(params)),
  ).data;
  const filter = usePullRequestFileFilter(diff.parsed);
  const parsed = filter.parsed;
  const files = parsed.kind === "files" ? parsed.files : [];
  // Commit diffs are a subset of the PR, so the PR-level totals would be wrong while loading.
  const expected = params.commit ? undefined : (pr ?? params.initialSummary);
  return {
    diff,
    filter,
    viewed,
    breakdown,
    parsed,
    files,
    loading: diff.isPending && parsed.kind === "empty" && !diff.error,
    expectedFileCount: pr?.changedFiles,
    expectedStats:
      expected?.additions !== undefined && expected.deletions !== undefined
        ? { additions: expected.additions, deletions: expected.deletions }
        : undefined,
    viewedCount: viewed.supported ? files.filter((file) => viewed.isViewed(file.path)).length : 0,
  };
}

export type PullRequestFilesState = ReturnType<typeof usePullRequestFiles>;

export function fileDirectory(path: string) {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}
