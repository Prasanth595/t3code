import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { IconButton } from "../../components/ui/IconButton";
import type { usePullRequestFilesData } from "./usePullRequestFilesData";
import type { usePullRequestFileFilter } from "./usePullRequestFileFilter";
export type FilesData = ReturnType<typeof usePullRequestFilesData>;
export function PullRequestFilesFooter({ data }: { readonly data: FilesData }) {
  const { result, parsed, viewed } = data;
  return (
    <>
      {result.nextCursor ? (
        <Button
          label={result.error ? "Retry loading files" : "Load more files"}
          tone="secondary"
          onPress={result.error ? result.refresh : result.loadMore}
          loading={result.isPending}
          fullWidth
        />
      ) : null}
      {viewed.error ? (
        <Text className="py-2 text-xs text-danger-foreground">{viewed.error}</Text>
      ) : null}
      {parsed.kind === "files" && parsed.notice ? (
        <Text className="py-4 text-xs text-foreground-muted">{parsed.notice}</Text>
      ) : null}
    </>
  );
}

export function PullRequestFilesEmptyState({ data }: { readonly data: FilesData }) {
  const { parsed, filter, result } = data;
  if (parsed.kind === "files" && parsed.files.length === 0 && filter.hiddenCount > 0)
    return (
      <EmptyState
        title={result.nextCursor ? "No non-test files loaded yet" : "Only test files changed"}
        detail="Test files are hidden from this review."
        action={<Button label="Show test files" tone="contrast" onPress={filter.showAll} />}
        variant="plain"
      />
    );
  if (parsed.kind !== "files" && !result.isPending && !result.error)
    return (
      <Text className="py-6 text-foreground-muted" textRole="body">
        No text changes available.
      </Text>
    );
  return null;
}

export function PullRequestFilesFilter({
  filter,
}: {
  readonly filter: Pick<ReturnType<typeof usePullRequestFileFilter>, "hideTestFiles" | "toggle">;
}) {
  return (
    <Menu
      title="Review files"
      actions={[
        {
          id: "hide-tests",
          title: "Hide test files",
          image: "line.3.horizontal.decrease",
          state: filter.hideTestFiles ? "on" : "off",
        },
      ]}
      onPressAction={filter.toggle}
    >
      <View pointerEvents="none">
        <IconButton
          icon="line.3.horizontal.decrease"
          accessibilityLabel="Filter review files"
          selected={filter.hideTestFiles}
        />
      </View>
    </Menu>
  );
}
