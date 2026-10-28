import * as Dialog from "../../../components/ui/Dialog";
import { SheetHeader } from "../../../components/ui/SheetHeader";
import { useOpenPullRequest } from "../../../native/useOpenPullRequest";
import {
  type GitActionRequestInput,
  buildMenuItems,
  getGitActionDisabledReason,
  requiresDefaultBranchConfirmation,
} from "@t3tools/client-runtime/state/vcs";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  CommonActions,
  StackActions,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { useEffect, useState } from "react";
import { Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";

import { ScreenStack } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeInspectorContent } from "../../../native/NativeInspectorContent";
import { NativeHeader, NativeScreen } from "../../../native/ThemedScreenStack";
import {
  AndroidHeaderIconButton,
  AndroidSheetHeader,
} from "../../../components/ui/AndroidScreenHeader";
import { AndroidAnchoredMenu } from "../../../components/ui/AndroidAnchoredMenu";
import { ListRow } from "../../../components/ui/ListRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { ListSection } from "../../../components/ui/ListSection";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { useAdaptiveWorkspaceLayout } from "../../layout/AdaptiveWorkspaceLayout";
import { AppText as Text } from "../../../components/ui/AppText";
import {
  NativeStackScreenOptions,
  nativeHeaderScrollEdgeEffects,
} from "../../../native/StackHeader";
import { useEnvironmentQuery } from "../../../state/query";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadRepositories } from "../../../state/use-thread-repositories";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { resolveGitOverviewReviewNavigationAction } from "./git-overview-navigation";
import {
  gitRepositoryRouteParams,
  gitRouteRepository,
  type GitRouteRepository,
} from "./gitRepositoryRoute";
import { menuItemIconName, statusSummary } from "./gitSheetComponents";
import {
  LinkedPullRequestRow,
  linkedPullRequestKey,
  useLinkedPullRequestLines,
} from "../LinkedPullRequestList";
import { useLinkedPullRequestActions } from "../useLinkedPullRequestActions";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type GitOverviewSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}> & {
  readonly headerInset?: number;
  readonly presentation?: "sheet" | "inspector";
};

export function GitOverviewSheet(props: GitOverviewSheetProps) {
  const navigation = useNavigation();
  const { environmentId, threadId } = props.route.params;
  const isBlankLink = environmentId.trim().length === 0 || threadId.trim().length === 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pops the navigator when the route link names a blank environment or thread
  useEffect(() => {
    if (isBlankLink) navigation.goBack();
  }, [isBlankLink, navigation]);
  if (isBlankLink) return null;
  return <GitOverviewSheetContent {...props} />;
}

/**
 * Commit, push and PR rows for one repo: the thread's own cwd, or one repo of a multi-repo
 * thread. Dialogs it opens act on the same repo.
 */
function useRepositoryGitMenu(options: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly isInspector: boolean;
  readonly openPullRequest: ReturnType<typeof useOpenPullRequest>;
  readonly repository?: GitRouteRepository;
}) {
  const { environmentId, threadId, isInspector, openPullRequest, repository } = options;
  const navigation = useNavigation();
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const cwd = repository?.target.cwd ?? selectedThreadCwd;
  const gitState = useSelectedThreadGitState(repository?.target);
  const gitActions = useSelectedThreadGitActions(repository?.target);
  const { canWriteSourceControl } = gitActions;

  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && cwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd },
        })
      : null,
  );

  const currentBranchLabel =
    gitStatus.data?.refName ??
    (repository === undefined || repository.target.home ? selectedThread?.branch : null) ??
    "Detached HEAD";
  const gitOperationLabel = gitState.gitOperationLabel;
  const busy = gitOperationLabel !== null;
  const isRepo = gitStatus.data?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus.data?.hasPrimaryRemote ?? false;
  const isDefaultRef = gitStatus.data?.isDefaultRef ?? false;

  const menuItems = isRepo ? buildMenuItems(gitStatus.data, busy, hasPrimaryRemote) : [];

  const sheetMenuItems = menuItems.map((item) => ({
    item: {
      ...item,
      disabled: item.disabled || (!canWriteSourceControl && item.kind !== "open_pr"),
    },
    disabledReason:
      !canWriteSourceControl && item.kind !== "open_pr"
        ? "This connection cannot change source control."
        : getGitActionDisabledReason({
            item,
            gitStatus: gitStatus.data,
            isBusy: busy,
            hasOriginRemote: hasPrimaryRemote,
          }),
  }));

  const { shortLabel, singular } = sourceControlClients.get(
    gitStatus.data?.sourceControlProvider?.kind,
  ).changeRequest;

  const openExistingPr = async () => {
    const prUrl = gitStatus.data?.pr?.state === "open" ? gitStatus.data.pr.url : null;
    if (!prUrl) {
      Dialog.alert(`No open ${shortLabel}`, `This branch does not have an open ${singular}.`);
      return;
    }
    if (!(await openPullRequest(prUrl))) {
      Dialog.alert(`Unable to open ${shortLabel}`, `The ${singular} could not be opened.`);
    }
  };

  const runActionWithPrompt = async (input: GitActionRequestInput) => {
    if (!canWriteSourceControl) return;
    const confirmableAction =
      input.action === "push" ||
      input.action === "create_pr" ||
      input.action === "commit_push" ||
      input.action === "commit_push_pr"
        ? input.action
        : null;
    const branchName = gitStatus.data?.refName;
    if (
      branchName &&
      confirmableAction &&
      !input.featureBranch &&
      requiresDefaultBranchConfirmation(input.action, isDefaultRef)
    ) {
      navigation.navigate("GitConfirm", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        confirmAction: confirmableAction,
        branchName,
        includesCommit: String(input.action === "commit_push" || input.action === "commit_push_pr"),
        ...gitRepositoryRouteParams(repository),
      });
      return;
    }

    if (!isInspector) {
      navigation.goBack();
    }
    await gitActions.onRunSelectedThreadGitAction(input);
  };

  const onPressMenuItem = async (item: (typeof menuItems)[number]) => {
    if (item.disabled) return;
    if (item.kind === "open_pr") {
      await openExistingPr();
      return;
    }
    if (!canWriteSourceControl) return;
    if (item.dialogAction === "commit") {
      navigation.navigate("GitCommit", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        ...gitRepositoryRouteParams(repository),
      });
      return;
    }
    if (item.dialogAction === "push") {
      await runActionWithPrompt({ action: "push" });
      return;
    }
    if (item.dialogAction === "create_pr") {
      await runActionWithPrompt({ action: "create_pr" });
    }
  };

  const rowStatusDetail = (item: (typeof menuItems)[number]): string | undefined => {
    const status = gitStatus.data;
    if (status == null) {
      return undefined;
    }
    if (item.dialogAction === "commit" && status.hasWorkingTreeChanges) {
      const fileCount = status.workingTree?.files.length ?? 0;
      return `${fileCount} file${fileCount === 1 ? "" : "s"} changed`;
    }
    if (item.dialogAction === "push" && (status.aheadCount ?? 0) > 0) {
      const ahead = status.aheadCount ?? 0;
      return `${ahead} commit${ahead === 1 ? "" : "s"} ahead`;
    }
    if (item.kind === "open_pr" && status.pr?.number != null) {
      return `${shortLabel} #${status.pr.number} ${status.pr.state ?? "open"}`;
    }
    return undefined;
  };

  const behindCount = gitStatus.data?.behindCount ?? 0;

  return {
    gitActions,
    busy,
    isRepo,
    currentBranchLabel,
    currentStatusSummary: statusSummary(gitStatus.data),
    sheetMenuItems,
    rowStatusDetail,
    onPressMenuItem,
    behindCount,
    canWriteSourceControl,
  };
}

function RepositoryMenuRows(props: { readonly menu: ReturnType<typeof useRepositoryGitMenu> }) {
  const { menu } = props;
  return (
    <>
      {menu.sheetMenuItems.map(({ item, disabledReason }) => (
        <ListRow
          key={`${item.id}-${item.label}`}
          icon={menuItemIconName(item.icon)}
          label={item.label}
          description={disabledReason ?? menu.rowStatusDetail(item)}
          disabled={item.disabled}
          onPress={() => void menu.onPressMenuItem(item)}
        />
      ))}
      {menu.behindCount > 0 ? (
        <ListRow
          icon="arrow.down.circle"
          label="Pull latest"
          description={
            menu.canWriteSourceControl
              ? `${menu.behindCount} commit${menu.behindCount === 1 ? "" : "s"} behind upstream`
              : "This connection cannot change source control."
          }
          disabled={!menu.canWriteSourceControl || menu.busy || !menu.isRepo}
          onPress={() => void menu.gitActions.onPullSelectedThreadBranch()}
        />
      ) : null}
    </>
  );
}

/** One repo of a multi-repo thread: its branch and status, then its own commit, push and PR. */
function RepositoryGitSection(props: {
  readonly repository: GitRouteRepository;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly isInspector: boolean;
  readonly openPullRequest: ReturnType<typeof useOpenPullRequest>;
}) {
  const menu = useRepositoryGitMenu(props);
  return (
    <ListSection title={props.repository.name}>
      <ListRowLayout
        icon="point.topleft.down.curvedto.point.bottomright.up"
        label={menu.currentBranchLabel}
        description={menu.currentStatusSummary}
      />
      <RepositoryMenuRows menu={menu} />
    </ListSection>
  );
}

function GitOverviewSheetContent(props: GitOverviewSheetProps) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const presentation = props.presentation ?? "sheet";
  const isInspector = presentation === "inspector";
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const openPullRequest = useOpenPullRequest({
    replace: presentation === "sheet",
    context: selectedThread ?? undefined,
  });
  const { selectedThreadWorktreePath } = useSelectedThreadWorktree();
  const linkedPrLines = useLinkedPullRequestLines(selectedThread, selectedEnvironmentRuntime);
  const linkedPrActions = useLinkedPullRequestActions({
    thread: selectedThread,
    project: selectedThreadProject,
    runtime: selectedEnvironmentRuntime,
  });
  const threadRepositories = useSelectedThreadRepositories();
  // Multi-repo threads get one section per repo; the thread's own menu stays the single-repo one.
  const repositories = threadRepositories.loading
    ? []
    : threadRepositories.multiRepository
      ? threadRepositories.repositories.map(gitRouteRepository)
      : null;
  const menu = useRepositoryGitMenu({ environmentId, threadId, isInspector, openPullRequest });
  const { gitActions, busy, isRepo } = menu;
  const { canChangeThreadBranch } = gitActions;
  const currentBranchLabel =
    repositories === null
      ? menu.currentBranchLabel
      : (selectedThreadProject?.title ?? "Repositories");
  const currentStatusSummary =
    repositories === null
      ? menu.currentStatusSummary
      : threadRepositories.loading
        ? "Loading repositories…"
        : `${repositories.length} repositor${repositories.length === 1 ? "y" : "ies"}`;
  const currentWorktreePath = threadRepositories.taskFolder?.root ?? selectedThreadWorktreePath;
  const showsBranches =
    repositories === null ||
    (threadRepositories.taskFolder === null &&
      repositories.some((repository) => repository.target.home));

  // Background refreshes also report pending; using that query flag would stick the RefreshControl spinner.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshStatus = async () => {
    await (repositories === null
      ? gitActions.refreshSelectedThreadGitStatus()
      : Promise.all(
          repositories.map((repository) =>
            gitActions.refreshSelectedThreadGitStatus({ cwd: repository.target.cwd }),
          ),
        ));
  };
  const handleRefresh = async () => {
    setIsRefreshing(true);
    await refreshStatus();
    setIsRefreshing(false);
  };

  const content = (
    <ScrollView
      nestedScrollEnabled
      alwaysBounceVertical
      className="flex-1 android:bg-sheet-solid ios:bg-screen"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      showsVerticalScrollIndicator={false}
      contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
      contentContainerStyle={{
        paddingHorizontal: Platform.OS === "android" ? 8 : isInspector ? 12 : 20,
        paddingTop: 8,
        gap: Platform.OS === "android" ? 8 : 14,
      }}
      refreshControl={
        Platform.OS === "ios" || isInspector ? (
          <RefreshControl refreshing={isRefreshing} onRefresh={() => void handleRefresh()} />
        ) : undefined
      }
    >
      {repositories?.map((repository) => (
        <RepositoryGitSection
          key={repository.target.cwd}
          repository={repository}
          environmentId={environmentId}
          threadId={threadId}
          isInspector={isInspector}
          openPullRequest={openPullRequest}
        />
      ))}
      <ListSection>
        {repositories === null ? <RepositoryMenuRows menu={menu} /> : null}
        <ListRow
          icon="text.bubble"
          label="Review changes"
          description="Inspect changes, uncommitted edits, and turn diffs"
          disabled={repositories === null && (busy || !isRepo)}
          onPress={() => {
            const params = { environmentId, threadId };
            navigation.dispatch(
              resolveGitOverviewReviewNavigationAction(presentation) === "replace"
                ? StackActions.replace("ThreadReview", params)
                : CommonActions.navigate("ThreadReview", params),
            );
          }}
        />
        {showsBranches ? (
          <ListRow
            icon="point.topleft.down.curvedto.point.bottomright.up"
            label="Branches & worktrees"
            description={
              canChangeThreadBranch
                ? "Switch branch, create branch, or move to a worktree"
                : "View branches and worktrees"
            }
            disabled={busy || !isRepo}
            onPress={() =>
              navigation.navigate("GitBranches", {
                environmentId: String(environmentId),
                threadId: String(threadId),
              })
            }
          />
        ) : null}
        {linkedPrActions.canLink ? (
          <ListRow
            icon="link"
            label={`Link ${linkedPrActions.terminology.singular}`}
            description={`Attach a ${linkedPrActions.terminology.singular} by URL or number`}
            onPress={linkedPrActions.promptLink}
          />
        ) : null}
      </ListSection>

      {linkedPrLines.length > 0 ? (
        <ListSection title={`Linked ${linkedPrActions.terminology.plural}`}>
          {linkedPrLines.map((line, index) => (
            <LinkedPullRequestRow
              key={linkedPullRequestKey(line)}
              line={line}
              separator={index < linkedPrLines.length - 1}
              surfaceClassName="text-grouped-card"
              openPullRequest={openPullRequest}
              actions={linkedPrActions}
            />
          ))}
        </ListSection>
      ) : null}

      {currentWorktreePath ? (
        <ListSection title={threadRepositories.taskFolder ? "Task folder" : "Worktree"}>
          <Text selectable textRole="footnote" className="p-4 text-foreground-muted">
            {currentWorktreePath}
          </Text>
        </ListSection>
      ) : null}
    </ScrollView>
  );

  if (isInspector && Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 border-l border-border bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-git-inspector-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            <NativeInspectorContent>{content}</NativeInspectorContent>
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              navigationItemStyle="editor"
              title={currentBranchLabel}
              titleColorClassName="accent-foreground"
              titleFontSize={17}
              titleFontWeight="700"
              translucent
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }

  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <SheetHeader
          presentation="native"
          title={currentBranchLabel}
          subtitle={currentStatusSummary}
          onClose={() => navigation.goBack()}
        />
        {content}
      </View>
    );
  }

  const refreshMenu = (
    <AndroidAnchoredMenu
      title="Repository options"
      actions={[
        {
          id: "refresh",
          title: "Refresh repository status",
          attributes: { disabled: busy || isRefreshing },
        },
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "refresh") void handleRefresh();
      }}
    >
      {(open) => (
        <AndroidHeaderIconButton
          accessibilityLabel="Repository options"
          icon="ellipsis"
          onPress={open}
        />
      )}
    </AndroidAnchoredMenu>
  );

  return (
    <View
      collapsable={false}
      className={
        Platform.OS === "android"
          ? "flex-1 bg-header"
          : isInspector
            ? "flex-1 border-l border-border bg-sheet"
            : "flex-1 bg-sheet"
      }
    >
      {!isInspector ? (
        <NativeStackScreenOptions
          options={{ sheetCornerRadius: Platform.OS === "android" ? 28 : undefined }}
        />
      ) : null}
      {isInspector ? (
        <View
          style={{
            minHeight: props.headerInset ?? 0,
            paddingTop: props.headerInset ?? 0,
          }}
        />
      ) : null}

      {isInspector ? (
        <View className="gap-1 px-4 pb-4 pt-3 android:bg-header ios:border-b ios:border-border">
          {Platform.OS === "android" ? (
            <View className="absolute right-3 top-4 z-[1]">{refreshMenu}</View>
          ) : (
            <Pressable
              className={
                busy
                  ? "absolute right-3 top-4 z-[1] h-9 w-9 items-center justify-center rounded-full bg-subtle opacity-[0.45]"
                  : "absolute right-3 top-4 z-[1] h-9 w-9 items-center justify-center rounded-full bg-subtle"
              }
              disabled={busy}
              onPress={() => void refreshStatus()}
            >
              <SymbolView
                name="arrow.clockwise"
                size={16}
                tintColorClassName="accent-icon"
                type="monochrome"
                weight="medium"
              />
            </Pressable>
          )}
          <Text className="text-xs font-t3-bold tracking-[1px] uppercase text-foreground-muted">
            Repository
          </Text>
          <Text className="pr-10 text-xl font-t3-bold">{currentBranchLabel}</Text>
          <Text className="text-foreground-secondary text-sm font-medium leading-normal">
            {currentStatusSummary}
          </Text>
        </View>
      ) : (
        <AndroidSheetHeader
          title={currentBranchLabel}
          hideBottomBorder={Platform.OS === "android"}
          subtitle={currentStatusSummary}
          onBack={() => navigation.goBack()}
          trailing={Platform.OS === "android" ? refreshMenu : undefined}
          actions={
            Platform.OS === "android"
              ? undefined
              : [
                  {
                    accessibilityLabel: "Refresh repository status",
                    disabled: busy,
                    icon: "arrow.clockwise",
                    onPress: () => void refreshStatus(),
                  },
                ]
          }
        />
      )}

      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}
