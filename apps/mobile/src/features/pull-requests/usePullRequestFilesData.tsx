import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import {
  pullRequestTarget as requestTarget,
  usePullRequestDiff,
  type PullRequestDiffParams,
} from "./usePullRequestDiff";
import { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";
import { usePullRequestFileFilter } from "./usePullRequestFileFilter";
import { PullRequestFileRow, PullRequestFileSkeleton } from "./PullRequestFileRow";

function fileDirectory(path: string) {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

export function usePullRequestFilesData(props: {
  readonly params: PullRequestDiffParams;
  readonly onSelectFile?: (path: string) => void;
  readonly groupByDirectory?: boolean;
}) {
  const navigation = useNavigation();
  const result = usePullRequestDiff(props.params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(requestTarget(props.params)));
  const viewed = usePullRequestFilesViewed(props.params, props.params.commit ? null : detail.data);
  const breakdown = useEnvironmentQuery(
    props.params.commit ? null : composerPullRequests.changeBreakdown(requestTarget(props.params)),
  ).data;
  const filter = usePullRequestFileFilter(result.parsed);
  const parsed = filter.parsed;
  const loading = result.isPending && parsed.kind === "empty" && !result.error;
  const fileCount = props.params.commit ? undefined : detail.data?.changedFiles;
  const summary = props.params.commit ? undefined : (detail.data ?? props.params.initialSummary);
  const [collapsedDirectories, setCollapsedDirectories] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const files = parsed.kind === "files" ? parsed.files : [];
  const orderedFiles = props.groupByDirectory
    ? [...files].sort(
        (a, b) =>
          fileDirectory(a.path).localeCompare(fileDirectory(b.path)) ||
          a.path.localeCompare(b.path),
      )
    : files;
  const rows = orderedFiles.map((file, index) => {
    const directory = fileDirectory(file.path);
    const previousDirectory = fileDirectory(orderedFiles[index - 1]?.path ?? "");
    const showDirectory =
      props.groupByDirectory && (index === 0 || directory !== previousDirectory);
    const collapsed = props.groupByDirectory && collapsedDirectories.has(directory);
    if (collapsed && !showDirectory) return null;
    return {
      key: file.id,
      content: (
        <PullRequestFileRow
          file={file}
          directory={directory}
          showDirectory={Boolean(showDirectory)}
          collapsed={Boolean(collapsed)}
          groupByDirectory={props.groupByDirectory}
          isViewed={viewed.isViewed(file.path)}
          onToggleDirectory={() =>
            setCollapsedDirectories((current) => {
              const next = new Set(current);
              if (next.has(directory)) next.delete(directory);
              else next.add(directory);
              return next;
            })
          }
          onSelect={() => {
            if (props.onSelectFile) props.onSelectFile(file.path);
            else navigation.navigate("PullRequestFile", { ...props.params, path: file.path });
          }}
        />
      ),
    };
  });
  return {
    refresh: result.refresh,
    filter,
    rows: loading
      ? Array.from({ length: Math.min(fileCount ?? 4, 6) }, (_, index) => ({
          key: `loading-file:${index}`,
          content: <PullRequestFileSkeleton index={index} />,
        }))
      : rows.filter((row) => row !== null),
    result,
    parsed,
    loading,
    fileCount,
    summary,
    viewed,
    breakdown,
  };
}
