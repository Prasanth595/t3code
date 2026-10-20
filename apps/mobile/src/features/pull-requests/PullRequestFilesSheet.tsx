import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { useState } from "react";
import { Platform, View } from "react-native";
import Animated from "react-native-reanimated";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { RowPressable } from "../../components/ui/RowPressable";
import { Toolbar } from "../../components/ui/Toolbar";
import type { ReviewRenderableFile } from "../review/reviewModel";
import { PR_ROW_ENTER, PR_ROW_EXIT, PR_ROW_LAYOUT } from "./pullRequestAnimations";
import {
  PullRequestFileRow,
  PullRequestFileRowSkeleton,
  PullRequestFilesEmptyState,
  PullRequestFilesFilterMenu,
  PullRequestFilesFooter,
  PullRequestFilesSummary,
  pullRequestFileSkeletonCount,
} from "./PullRequestFileList";
import { PullRequestDiffStats, PullRequestReadStatus } from "./PullRequestPresentation";
import { PullRequestSheetContent } from "./PullRequestSheetContent";
import type { PullRequestDiffParams } from "./usePullRequestDiff";
import { fileDirectory, usePullRequestFiles } from "./usePullRequestFiles";

type SheetItem =
  | { readonly kind: "directory"; readonly key: string; readonly directory: string }
  | { readonly kind: "file"; readonly key: string; readonly file: ReviewRenderableFile }
  | { readonly kind: "skeleton"; readonly key: string; readonly index: number };

function directoryItems(
  files: ReadonlyArray<ReviewRenderableFile>,
  collapsed: ReadonlySet<string>,
): SheetItem[] {
  const sorted = files
    .map((file) => ({ file, directory: fileDirectory(file.path) }))
    .sort(
      (a, b) => a.directory.localeCompare(b.directory) || a.file.path.localeCompare(b.file.path),
    );
  const items: SheetItem[] = [];
  sorted.forEach(({ file, directory }, index) => {
    if (index === 0 || directory !== sorted[index - 1]?.directory) {
      items.push({ kind: "directory", key: `directory:${directory}`, directory });
    }
    if (!collapsed.has(directory)) items.push({ kind: "file", key: file.id, file });
  });
  return items;
}

function PullRequestDirectoryRow(props: {
  readonly directory: string;
  readonly collapsed: boolean;
  readonly onPress: () => void;
}) {
  const label = props.directory || "Repository root";
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: !props.collapsed }}
      onPress={props.onPress}
      className="min-h-11 flex-row items-center gap-2 pt-4 pb-2"
    >
      <SymbolView
        name={props.collapsed ? "chevron.right" : "chevron.down"}
        size={11}
        tintColorClassName="accent-icon-muted"
      />
      <SymbolView name="folder" size={16} tintColorClassName="accent-icon-muted" />
      <Text textRole="label" className="min-w-0 flex-1 text-foreground-muted" numberOfLines={2}>
        {label}
      </Text>
    </RowPressable>
  );
}

/** Changed-file picker presented over a file diff; files are grouped by directory. */
export function PullRequestFilesSheet(props: {
  readonly params: PullRequestDiffParams;
  readonly onSelectFile: (path: string) => void;
}) {
  const { params } = props;
  const state = usePullRequestFiles(params);
  const { diff, parsed, filter, loading } = state;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [animationsReady, setAnimationsReady] = useState(false);
  const stats = parsed.kind === "files" ? parsed : state.expectedStats;
  const toggleDirectory = (directory: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(directory)) next.add(directory);
      return next;
    });
  const items: SheetItem[] = loading
    ? Array.from({ length: pullRequestFileSkeletonCount(state) }, (_, index) => ({
        kind: "skeleton",
        key: `loading-file:${index}`,
        index,
      }))
    : directoryItems(state.files, collapsed);

  return (
    <PullRequestSheetContent
      title="Changed files"
      subtitle={`#${params.number} · ${params.commit ? params.commit.slice(0, 7) : params.repository}`}
      scrollable={false}
      trailing={
        Platform.OS === "android" ? <PullRequestFilesFilterMenu filter={filter} /> : undefined
      }
    >
      {Platform.OS === "ios" ? (
        <Toolbar placement="right">
          <Toolbar.Menu
            title="Review files"
            accessibilityLabel="Filter review files"
            icon="line.3.horizontal.decrease"
          >
            <Toolbar.MenuAction
              icon="line.3.horizontal.decrease"
              isOn={filter.hideTestFiles}
              onPress={filter.toggle}
            >
              <Toolbar.Label>Hide test files</Toolbar.Label>
            </Toolbar.MenuAction>
          </Toolbar.Menu>
        </Toolbar>
      ) : null}
      <AnimatedLegendList
        data={items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        itemLayoutAnimation={PR_ROW_LAYOUT}
        onLoad={() => setAnimationsReady(true)}
        renderItem={({ item }) => (
          <Animated.View
            entering={animationsReady ? PR_ROW_ENTER : undefined}
            exiting={animationsReady ? PR_ROW_EXIT : undefined}
          >
            {item.kind === "directory" ? (
              <PullRequestDirectoryRow
                directory={item.directory}
                collapsed={collapsed.has(item.directory)}
                onPress={() => toggleDirectory(item.directory)}
              />
            ) : item.kind === "file" ? (
              <PullRequestFileRow
                file={item.file}
                showDirectory={false}
                viewed={state.viewed.isViewed(item.file.path)}
                onPress={() => props.onSelectFile(item.file.path)}
              />
            ) : (
              <PullRequestFileRowSkeleton index={item.index} />
            )}
          </Animated.View>
        )}
        contentInsetAdjustmentBehavior="automatic"
        recycleItems={false}
        estimatedItemSize={64}
        ListHeaderComponent={
          <>
            <PullRequestReadStatus pending={false} error={diff.error} />
            {loading || parsed.kind === "files" ? (
              <View
                accessible={loading}
                accessibilityLabel={loading ? "Loading changed files" : undefined}
                accessibilityState={loading ? { busy: true } : undefined}
                className="flex-row items-center gap-2 py-2"
              >
                <View className="min-w-0 flex-1">
                  <PullRequestFilesSummary state={state} />
                </View>
                {stats ? (
                  <PullRequestDiffStats
                    additions={stats.additions}
                    deletions={stats.deletions}
                    compact
                  />
                ) : null}
              </View>
            ) : null}
            <PullRequestFilesEmptyState state={state} />
          </>
        }
        ListFooterComponent={<PullRequestFilesFooter state={state} />}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 20 }}
      />
    </PullRequestSheetContent>
  );
}
