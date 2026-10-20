import type { PullRequestChangeBreakdown } from "@t3tools/contracts";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { PullRequestSectionHeading } from "./PullRequestSectionHeading";
import { PullRequestDiffStats, PullRequestReadStatus } from "./PullRequestPresentation";
import { usePullRequestFilesData } from "./usePullRequestFilesData";
import {
  PullRequestFilesEmptyState,
  PullRequestFilesFilter,
  PullRequestFilesFooter,
  type FilesData,
} from "./PullRequestFilesShared";
const BREAKDOWN_LABELS = {
  code: "Code",
  tests: "Tests",
  mocks: "Mocks",
  generated: "Generated",
  docs: "Docs",
} satisfies Record<keyof NonNullable<PullRequestChangeBreakdown>, string>;

function PullRequestChangeBreakdownLine(props: {
  readonly breakdown: NonNullable<PullRequestChangeBreakdown>;
}) {
  const parts = (Object.keys(BREAKDOWN_LABELS) as Array<keyof typeof BREAKDOWN_LABELS>).flatMap(
    (kind) => {
      const { additions, deletions } = props.breakdown[kind];
      return additions === 0 && deletions === 0
        ? []
        : [
            `${BREAKDOWN_LABELS[kind]} +${additions.toLocaleString()} −${deletions.toLocaleString()}`,
          ];
    },
  );
  return (
    <Text className="text-2xs tabular-nums text-foreground-muted" numberOfLines={2}>
      {parts.join(" · ")}
    </Text>
  );
}

function PullRequestFilesSectionHeader({ data }: { readonly data: FilesData }) {
  const { result, parsed, loading, fileCount, summary, viewed, breakdown, filter } = data;
  return (
    <>
      <PullRequestReadStatus pending={false} error={result.error} />
      {loading ? (
        <View
          accessibilityLabel="Loading changed files"
          accessibilityState={{ busy: true }}
          className="min-h-17 flex-row items-center gap-2 py-3"
        >
          <View className="min-w-0 flex-1 gap-1">
            <PullRequestSectionHeading>Changed files</PullRequestSectionHeading>
            {fileCount !== undefined ? (
              <Text className="text-2xs text-foreground-muted">
                {fileCount} {fileCount === 1 ? "file" : "files"}
              </Text>
            ) : (
              <View className="h-2.5 w-28 rounded bg-subtle-strong" />
            )}
          </View>
          {summary?.additions !== undefined && summary.deletions !== undefined ? (
            <PullRequestDiffStats
              additions={summary.additions}
              deletions={summary.deletions}
              compact
            />
          ) : null}
          <View className="size-11 items-center justify-center opacity-40">
            <SymbolView
              name="line.3.horizontal.decrease"
              size={20}
              tintColorClassName="accent-icon-muted"
            />
          </View>
        </View>
      ) : parsed.kind === "files" ? (
        <>
          <View className="min-h-17 flex-row items-center gap-2 py-3">
            <View className="min-w-0 flex-1 gap-1">
              <PullRequestSectionHeading>Changed files</PullRequestSectionHeading>
              <Text className="text-2xs text-foreground-muted">
                {parsed.fileCount} {filter.hiddenCount ? "visible" : "changed"}{" "}
                {parsed.fileCount === 1 ? "file" : "files"}
                {viewed.supported
                  ? ` · ${parsed.files.filter((file) => viewed.isViewed(file.path)).length} viewed`
                  : ""}
                {" · "}
                {filter.hideTestFiles
                  ? `${filter.hiddenCount} test ${filter.hiddenCount === 1 ? "file" : "files"} hidden`
                  : "Test files included"}
              </Text>
              {breakdown ? <PullRequestChangeBreakdownLine breakdown={breakdown} /> : null}
            </View>
            <PullRequestDiffStats
              additions={parsed.additions}
              deletions={parsed.deletions}
              compact
            />
            <PullRequestFilesFilter filter={filter} />
          </View>
        </>
      ) : null}
      <PullRequestFilesEmptyState data={data} />
    </>
  );
}

export function usePullRequestFilesSection(props: Parameters<typeof usePullRequestFilesData>[0]) {
  const data = usePullRequestFilesData(props);
  return {
    refresh: data.refresh,
    filter: data.filter,
    rows: data.rows,
    header: <PullRequestFilesSectionHeader data={data} />,
    footer: <PullRequestFilesFooter data={data} />,
  };
}
