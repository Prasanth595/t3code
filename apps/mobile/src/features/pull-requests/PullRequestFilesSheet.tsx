import { AnimatedLegendList } from "@legendapp/list/reanimated";
import Animated from "react-native-reanimated";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { PR_ROW_LAYOUT, PR_ROW_ENTER, PR_ROW_EXIT } from "./pullRequestAnimations";
import { PullRequestDiffStats, PullRequestReadStatus } from "./PullRequestPresentation";
import { usePullRequestFilesData } from "./usePullRequestFilesData";
import {
  PullRequestFilesEmptyState,
  PullRequestFilesFooter,
  type FilesData,
} from "./PullRequestFilesShared";
function PullRequestFilesSheetHeader({ data }: { readonly data: FilesData }) {
  const { parsed, loading, fileCount, summary, viewed, filter } = data;
  return (
    <>
      <PullRequestReadStatus pending={false} error={data.result.error} />
      {loading ? (
        <View
          accessible
          accessibilityLabel="Loading changed files"
          accessibilityState={{ busy: true }}
          className="flex-row items-center gap-2 py-2"
        >
          <View className="flex-1">
            {fileCount !== undefined ? (
              <Text textRole="caption" className="text-foreground-muted">
                {fileCount} {fileCount === 1 ? "file" : "files"}
              </Text>
            ) : (
              <View className="h-2.5 w-28 rounded bg-subtle-strong" />
            )}
          </View>
          {summary ? (
            <PullRequestDiffStats
              additions={summary.additions}
              deletions={summary.deletions}
              compact
            />
          ) : null}
        </View>
      ) : parsed.kind === "files" ? (
        <View className="flex-row items-center gap-2 py-2">
          <Text textRole="caption" className="min-w-0 flex-1 text-foreground-muted">
            {parsed.fileCount} {filter.hiddenCount ? "visible" : "changed"}{" "}
            {parsed.fileCount === 1 ? "file" : "files"}
            {viewed.supported
              ? ` · ${parsed.files.filter((file) => viewed.isViewed(file.path)).length} viewed`
              : ""}
            {filter.hideTestFiles
              ? ` · ${filter.hiddenCount} test ${filter.hiddenCount === 1 ? "file" : "files"} hidden`
              : ""}
          </Text>
          <PullRequestDiffStats additions={parsed.additions} deletions={parsed.deletions} compact />
        </View>
      ) : null}
      <PullRequestFilesEmptyState data={data} />
    </>
  );
}

export function usePullRequestFilesSheetContent(
  props: Parameters<typeof usePullRequestFilesData>[0],
) {
  const data = usePullRequestFilesData(props);
  return {
    filter: data.filter,
    rows: data.rows,
    header: <PullRequestFilesSheetHeader data={data} />,
    footer: <PullRequestFilesFooter data={data} />,
  };
}

export function PullRequestFilesSheet({
  content,
}: {
  readonly content: ReturnType<typeof usePullRequestFilesSheetContent>;
}) {
  const [animationsReady, setAnimationsReady] = useState(false);
  return (
    <AnimatedLegendList
      data={content.rows}
      keyExtractor={(row) => row.key}
      itemLayoutAnimation={PR_ROW_LAYOUT}
      onLoad={() => setAnimationsReady(true)}
      renderItem={({ item }) => (
        <Animated.View
          key={item.key}
          entering={animationsReady ? PR_ROW_ENTER : undefined}
          exiting={animationsReady ? PR_ROW_EXIT : undefined}
        >
          {item.content}
        </Animated.View>
      )}
      contentInsetAdjustmentBehavior="automatic"
      recycleItems={false}
      estimatedItemSize={64}
      ListHeaderComponent={content.header}
      ListFooterComponent={content.footer}
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 20 }}
    />
  );
}
