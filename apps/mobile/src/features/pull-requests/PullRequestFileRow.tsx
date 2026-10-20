import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { RowPressable } from "../../components/ui/RowPressable";
import { SymbolView } from "../../components/ui/AppSymbol";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import type { ReviewRenderableFile } from "../review/reviewModel";
import { PullRequestDiffStats } from "./PullRequestPresentation";

export function PullRequestFileRow({
  file,
  directory,
  showDirectory,
  collapsed,
  groupByDirectory,
  isViewed,
  onToggleDirectory,
  onSelect,
}: {
  readonly file: ReviewRenderableFile;
  readonly directory: string;
  readonly showDirectory: boolean;
  readonly collapsed: boolean;
  readonly groupByDirectory?: boolean;
  readonly isViewed: boolean;
  readonly onToggleDirectory: () => void;
  readonly onSelect: () => void;
}) {
  return (
    <View>
      {showDirectory ? (
        <RowPressable
          accessibilityRole="button"
          accessibilityLabel={directory || "Repository root"}
          accessibilityState={{ expanded: !collapsed }}
          onPress={onToggleDirectory}
          className="min-h-11 flex-row items-center gap-2 pt-4 pb-2 active:opacity-70"
        >
          <SymbolView
            name={collapsed ? "chevron.right" : "chevron.down"}
            size={11}
            tintColorClassName="accent-icon-muted"
          />
          <SymbolView name="folder" size={16} tintColorClassName="accent-icon-muted" />
          <Text textRole="label" className="min-w-0 flex-1 text-foreground-muted" numberOfLines={2}>
            {directory || "Repository root"}
          </Text>
        </RowPressable>
      ) : null}
      {!collapsed ? (
        <RowPressable
          accessibilityRole="button"
          accessibilityLabel={`View diff for ${file.path}, ${file.additions} additions, ${file.deletions} deletions`}
          onPress={onSelect}
          className="min-h-14 flex-row items-center gap-3 border-b border-border-subtle py-3 active:opacity-70"
        >
          <PierreEntryIcon kind="file" path={file.path} size={20} />
          <View className="min-w-0 flex-1">
            <Text textRole="footnote" className="font-t3-medium" numberOfLines={2}>
              {file.path.split("/").at(-1)}
            </Text>
            {directory && !groupByDirectory ? (
              <Text textRole="caption" className="mt-0.5 text-foreground-muted" numberOfLines={1}>
                {directory}
              </Text>
            ) : null}
            {file.previousPath ? (
              <Text textRole="caption" className="mt-0.5 text-foreground-muted" numberOfLines={1}>
                Renamed from {file.previousPath}
              </Text>
            ) : null}
          </View>
          <PullRequestDiffStats additions={file.additions} deletions={file.deletions} compact />
          {isViewed ? (
            <SymbolView
              name="checkmark.circle.fill"
              size={18}
              tintColorClassName="accent-adaptive-emerald-600-400"
            />
          ) : null}
          <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
        </RowPressable>
      ) : null}
    </View>
  );
}

export function PullRequestFileSkeleton({ index }: { readonly index: number }) {
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
          style={{ width: index % 2 ? "65%" : "80%" }}
        />
        <View className="h-2.5 w-2/5 rounded bg-subtle-strong" />
      </View>
      <View className="h-3 w-7 rounded bg-subtle-strong" />
    </View>
  );
}
