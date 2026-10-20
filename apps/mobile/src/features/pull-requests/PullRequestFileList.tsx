import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { RowPressable } from "../../components/ui/RowPressable";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import type { ReviewRenderableFile } from "../review/reviewModel";
import { PullRequestDiffStats } from "./PullRequestPresentation";
import { fileDirectory, type PullRequestFilesState } from "./usePullRequestFiles";

// File rows carry a type icon, diff stats, and viewed state, which ListRow's label/detail
// layout cannot express, so they share RowPressable and the list hairline directly.

export function PullRequestFileRow(props: {
  readonly file: ReviewRenderableFile;
  readonly showDirectory: boolean;
  readonly viewed: boolean;
  readonly onPress: () => void;
}) {
  const { file } = props;
  const directory = props.showDirectory ? fileDirectory(file.path) : "";
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={`View diff for ${file.path}, ${file.additions} additions, ${file.deletions} deletions${props.viewed ? ", viewed" : ""}`}
      onPress={props.onPress}
      className="min-h-14 flex-row items-center gap-3 border-b border-border-subtle py-3"
    >
      <PierreEntryIcon kind="file" path={file.path} size={20} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text textRole="footnote" className="font-t3-medium" numberOfLines={2}>
          {file.path.split("/").at(-1)}
        </Text>
        {directory ? (
          <Text textRole="caption" className="text-foreground-muted" numberOfLines={1}>
            {directory}
          </Text>
        ) : null}
        {file.previousPath ? (
          <Text textRole="caption" className="text-foreground-muted" numberOfLines={1}>
            Renamed from {file.previousPath}
          </Text>
        ) : null}
      </View>
      <PullRequestDiffStats additions={file.additions} deletions={file.deletions} compact />
      {props.viewed ? (
        <SymbolView
          name="checkmark.circle.fill"
          size={18}
          tintColorClassName="accent-adaptive-emerald-600-400"
        />
      ) : null}
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
    </RowPressable>
  );
}

export function PullRequestFileRowSkeleton(props: { readonly index: number }) {
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      className="min-h-14 flex-row items-center gap-3 border-b border-border-subtle py-3"
    >
      <View className="size-5 rounded-md bg-subtle-strong" />
      <View className="flex-1 gap-2">
        <View
          className="h-3.5 rounded bg-subtle-strong"
          style={{ width: props.index % 2 ? "65%" : "80%" }}
        />
        <View className="h-2.5 w-2/5 rounded bg-subtle-strong" />
      </View>
      <View className="h-3 w-7 rounded bg-subtle-strong" />
    </View>
  );
}

export function pullRequestFileSkeletonCount(state: PullRequestFilesState) {
  return Math.min(state.expectedFileCount ?? 4, 6);
}

/** File count, viewed progress, and filter state; a placeholder while the first page loads. */
export function PullRequestFilesSummary(props: { readonly state: PullRequestFilesState }) {
  const { parsed, filter, viewed, viewedCount, expectedFileCount } = props.state;
  if (parsed.kind !== "files") {
    return expectedFileCount !== undefined ? (
      <Text textRole="caption" className="text-foreground-muted">
        {expectedFileCount} {expectedFileCount === 1 ? "file" : "files"}
      </Text>
    ) : (
      <View className="h-2.5 w-28 rounded bg-subtle-strong" />
    );
  }
  const parts = [
    `${parsed.fileCount} ${filter.hiddenCount ? "visible" : "changed"} ${parsed.fileCount === 1 ? "file" : "files"}`,
    viewed.supported ? `${viewedCount} viewed` : null,
    filter.hideTestFiles
      ? `${filter.hiddenCount} test ${filter.hiddenCount === 1 ? "file" : "files"} hidden`
      : null,
  ];
  return (
    <Text textRole="caption" className="text-foreground-muted">
      {parts.filter(Boolean).join(" · ")}
    </Text>
  );
}

export function PullRequestFilesFilterMenu(props: {
  readonly filter: PullRequestFilesState["filter"];
  readonly disabled?: boolean;
}) {
  const button = (
    <IconButton
      icon="line.3.horizontal.decrease"
      accessibilityLabel="Filter review files"
      selected={props.filter.hideTestFiles}
      disabled={props.disabled}
    />
  );
  if (props.disabled) return button;
  return (
    <Menu
      title="Review files"
      actions={[
        {
          id: "hide-tests",
          title: "Hide test files",
          image: "line.3.horizontal.decrease",
          state: props.filter.hideTestFiles ? "on" : "off",
        },
      ]}
      onPressAction={props.filter.toggle}
    >
      <View pointerEvents="none">{button}</View>
    </Menu>
  );
}

export function PullRequestFilesEmptyState(props: { readonly state: PullRequestFilesState }) {
  const { parsed, filter, diff } = props.state;
  if (parsed.kind === "files") {
    return parsed.files.length === 0 && filter.hiddenCount > 0 ? (
      <EmptyState
        title={diff.nextCursor ? "No non-test files loaded yet" : "Only test files changed"}
        detail="Test files are hidden from this review."
        action={<Button label="Show test files" tone="contrast" onPress={filter.showAll} />}
        variant="plain"
      />
    ) : null;
  }
  return !diff.isPending && !diff.error ? (
    <Text textRole="footnote" className="py-6 text-foreground-muted">
      No text changes available.
    </Text>
  ) : null;
}

export function PullRequestFilesFooter(props: { readonly state: PullRequestFilesState }) {
  const { diff, viewed, parsed } = props.state;
  return (
    <>
      {diff.nextCursor ? (
        <Button
          label={diff.error ? "Retry loading files" : "Load more files"}
          tone="secondary"
          onPress={diff.error ? diff.refresh : diff.loadMore}
          loading={diff.isPending}
          fullWidth
        />
      ) : null}
      {viewed.error ? (
        <Text textRole="label" className="py-2 text-danger-foreground">
          {viewed.error}
        </Text>
      ) : null}
      {parsed.kind === "files" && parsed.notice ? (
        <Text textRole="label" className="py-4 text-foreground-muted">
          {parsed.notice}
        </Text>
      ) : null}
    </>
  );
}
