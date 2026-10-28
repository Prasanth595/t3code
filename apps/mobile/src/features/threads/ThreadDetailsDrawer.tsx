import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { AuthFilesystemReadScope, EnvironmentId, type ProjectId } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { getTerminalStatusLabel } from "../terminal/terminalMenu";
import { GitOverviewSheet } from "./git/GitOverviewSheet";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { useEnvironmentScope } from "../../state/session";
import { ThreadProjectActions } from "./ThreadProjectActions";
import type { ThreadGitControls } from "./ThreadGitControls";
import {
  ThreadListDrawerHost,
  threadListDrawerWidth,
  useThreadDetailsDrawer,
} from "./thread-list-drawer";

export interface ThreadWorkspaceDetails {
  readonly projectTitle: string;
  readonly projectId: ProjectId | null;
  readonly workspaceRoot: string | null;
  readonly environmentLabel: string;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly cwd: string | null;
  readonly worktreePath: string | null;
}

export function ThreadDetailsDrawer(props: {
  readonly title: string;
  readonly workspace: ThreadWorkspaceDetails;
  readonly gitControls: Parameters<typeof ThreadGitControls>[0];
  readonly onCloseThread: () => void;
  readonly onReturnToThread?: (() => void) | undefined;
}) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const { width } = useWindowDimensions();
  return (
    <ThreadListDrawerHost side="right" width={threadListDrawerWidth(layout.listPaneWidth, width)}>
      {() => <ThreadDetailsContent {...props} />}
    </ThreadListDrawerHost>
  );
}

function ThreadDetailsContent(props: Parameters<typeof ThreadDetailsDrawer>[0]) {
  const insets = useSafeAreaInsets();
  const { closeDrawer } = useThreadDetailsDrawer();
  const controls = props.gitControls;
  const { workspace } = props;
  const environmentId = EnvironmentId.make(String(controls.environmentId));
  const canReadFiles = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const cwd = workspace.cwd;
  const navigate = (action: () => void) => {
    closeDrawer();
    action();
  };
  return (
    <View
      className="flex-1 bg-header"
      style={{ paddingTop: Platform.OS === "android" ? insets.top : 0 }}
    >
      <View className="flex-row items-center justify-between gap-3 px-5 py-4">
        <View className="min-w-0 flex-1 gap-1">
          <Text textRole="title" className="font-t3-bold">
            Thread details
          </Text>
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={2}>
            {props.title}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close thread details"
          onPress={closeDrawer}
          className="h-11 w-11 items-center justify-center rounded-full active:bg-subtle"
        >
          <SymbolView name="xmark" size={20} tintColorClassName="accent-header-foreground" />
        </Pressable>
      </View>
      <ScrollView
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
        contentContainerStyle={{
          paddingHorizontal: 12,
          paddingBottom: Math.max(insets.bottom, 18),
          gap: 20,
        }}
      >
        <ListSection title="Workspace">
          {props.onReturnToThread ? (
            <ListRow
              icon="chevron.left"
              label="Return to chat"
              onPress={() => navigate(() => props.onReturnToThread?.())}
            />
          ) : null}
          <View className="gap-2 px-4 py-4">
            <Text textRole="body" className="font-t3-medium">
              {workspace.environmentLabel}
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              {workspace.connectionState.charAt(0).toUpperCase() +
                workspace.connectionState.slice(1)}{" "}
              · {workspace.projectTitle}
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              {workspace.worktreePath ? "Worktree" : "Project directory"}
            </Text>
            <Text selectable textRole="footnote">
              {workspace.cwd ?? "Workspace unavailable"}
            </Text>
          </View>
          {workspace.cwd ? (
            <ListRow
              icon="doc.on.doc"
              label="Copy workspace path"
              onPress={() => {
                if (cwd) void Clipboard.setStringAsync(cwd);
              }}
            />
          ) : null}
          <ListRow
            icon="folder"
            label="Browse files"
            disabled={!controls.canOpenFiles || !canReadFiles}
            onPress={() => navigate(() => controls.onOpenFilesInspector?.())}
          />
        </ListSection>

        {workspace.projectId !== null ? (
          <ThreadProjectActions
            key={`${environmentId}:${workspace.projectId}`}
            environmentId={environmentId}
            projectId={workspace.projectId}
            cwd={workspace.workspaceRoot}
            scripts={controls.projectScripts}
            canRun={controls.canOperateTerminal && controls.hasThread !== false}
            onRun={(script) => navigate(() => void controls.onRunProjectScript(script))}
          />
        ) : null}

        <ListSection
          title="Terminal"
          footer={
            !controls.canOperateTerminal
              ? "Terminal commands require a saved thread and terminal access."
              : undefined
          }
        >
          {controls.terminalSessions.map((session) => (
            <ListRow
              key={session.terminalId}
              icon="terminal"
              label={session.displayLabel}
              description={getTerminalStatusLabel(session)}
              disabled={!controls.canOpenTerminal}
              onPress={() => navigate(() => controls.onOpenTerminal(session.terminalId))}
            />
          ))}
          <ListRow
            icon="terminal"
            label="New terminal"
            disabled={!controls.canOperateTerminal}
            onPress={() => navigate(controls.onOpenNewTerminal)}
          />
          {controls.onMergeBack ? (
            <ListRow
              icon={PullRequestGlyph.merged}
              label="Merge back to source"
              onPress={() => navigate(() => controls.onMergeBack?.())}
            />
          ) : null}
        </ListSection>

        {controls.hasThread === false ? (
          <ListSection title="Source control">
            <Text textRole="footnote" className="px-4 py-4">
              {controls.gitStatus?.refName ?? controls.currentBranch ?? "Detached HEAD"}
            </Text>
            <Text textRole="footnote" className="px-4 pb-4 text-foreground-muted">
              Send the first message to use source control and worktree actions.
            </Text>
          </ListSection>
        ) : (
          <GitOverviewSheet
            key={`${controls.environmentId}:${controls.threadId}`}
            presentation="drawer"
            route={{
              params: {
                environmentId: String(controls.environmentId),
                threadId: String(controls.threadId),
              },
            }}
            onNavigate={closeDrawer}
          />
        )}

        <ListSection>
          <ListRow
            icon="chevron.left"
            label="Close thread"
            onPress={() => navigate(props.onCloseThread)}
          />
        </ListSection>
      </ScrollView>
    </View>
  );
}
