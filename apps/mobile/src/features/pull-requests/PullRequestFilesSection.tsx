import type { PullRequestChangeBreakdown } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { PullRequestSectionHeading } from "./PullRequestSectionHeading";
import { PullRequestDiffStats, PullRequestReadStatus } from "./PullRequestPresentation";
import {
  PullRequestFileRow,
  PullRequestFileRowSkeleton,
  PullRequestFilesEmptyState,
  PullRequestFilesFilterMenu,
  PullRequestFilesFooter,
  PullRequestFilesSummary,
  pullRequestFileSkeletonCount,
} from "./PullRequestFileList";
import type { PullRequestDiffParams } from "./usePullRequestDiff";
import { usePullRequestFiles } from "./usePullRequestFiles";

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
    <Text textRole="caption" className="tabular-nums text-foreground-muted" numberOfLines={2}>
      {parts.join(" · ")}
    </Text>
  );
}

/**
 * The changed-files section of the PR overview. Its parts are spliced into the overview tab's
 * list rather than rendered as a nested list, so this returns header, rows, and footer.
 */
export function usePullRequestFilesSection(params: PullRequestDiffParams) {
  const navigation = useNavigation();
  const state = usePullRequestFiles(params);
  const { diff, parsed, filter, loading, breakdown } = state;
  const stats = parsed.kind === "files" ? parsed : state.expectedStats;
  return {
    refresh: diff.refresh,
    header: (
      <>
        <PullRequestReadStatus pending={false} error={diff.error} />
        {loading || parsed.kind === "files" ? (
          <View
            accessible={loading}
            accessibilityLabel={loading ? "Loading changed files" : undefined}
            accessibilityState={loading ? { busy: true } : undefined}
            className="min-h-17 flex-row items-center gap-2 py-3"
          >
            <View className="min-w-0 flex-1 gap-1">
              <PullRequestSectionHeading>Changed files</PullRequestSectionHeading>
              <PullRequestFilesSummary state={state} />
              {!loading && breakdown ? (
                <PullRequestChangeBreakdownLine breakdown={breakdown} />
              ) : null}
            </View>
            {stats ? (
              <PullRequestDiffStats
                additions={stats.additions}
                deletions={stats.deletions}
                compact
              />
            ) : null}
            <PullRequestFilesFilterMenu filter={filter} disabled={loading} />
          </View>
        ) : null}
        <PullRequestFilesEmptyState state={state} />
      </>
    ),
    rows: loading
      ? Array.from({ length: pullRequestFileSkeletonCount(state) }, (_, index) => ({
          key: `loading-file:${index}`,
          content: <PullRequestFileRowSkeleton index={index} />,
        }))
      : state.files.map((file) => ({
          key: file.id,
          content: (
            <PullRequestFileRow
              file={file}
              showDirectory
              viewed={state.viewed.isViewed(file.path)}
              onPress={() => navigation.navigate("PullRequestFile", { ...params, path: file.path })}
            />
          ),
        })),
    footer: <PullRequestFilesFooter state={state} />,
  };
}
