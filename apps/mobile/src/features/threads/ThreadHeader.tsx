import { useMemo } from "react";
import { ThreadDetailsDrawer, type ThreadWorkspaceDetails } from "./ThreadDetailsDrawer";
import { useThreadDetailsDrawer } from "./thread-list-drawer";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenHeaderButton } from "../../components/ui/ScreenHeaderButton";
import type { AppBarAction } from "../../components/ui/AppBar.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-content-stack";
import { useThreadHeaderOptions } from "./useThreadHeaderOptions";
import { useWorkspaceBackNavigation } from "../workspace/useAndroidWorkspaceNavigation";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import {
  ThreadFloatingHeader,
  ThreadFloatingTopScrim,
  usesFloatingThreadControls,
} from "./ThreadFloatingControls";

export function ThreadHeader(
  props: Parameters<typeof useThreadHeaderOptions>[0] & {
    readonly workspace: ThreadWorkspaceDetails;
    readonly hasThreadCwd: boolean;
    readonly hasWorkspaceRoot: boolean;
    readonly fileInspectorSupported: boolean;
    readonly inspectorMode: ThreadInspectorMode | null;
    readonly onToggleInspector: () => void;
    readonly onOpenGitInspector: () => void;
    readonly onOpenFilesInspector: () => void;
  },
) {
  const goBack = useWorkspaceBackNavigation("threads");
  const { layout, panes, toggleAuxiliaryPane, composerKeyboardActive } =
    useAdaptiveWorkspaceLayout();
  const { onOpenTerminal, onMergeBack } = props.gitControls;
  const details = useThreadDetailsDrawer();
  const native = useThreadHeaderOptions({
    ...props,
    onOpenThreadDetails: layout.usesSplitView ? undefined : details.openDrawer,
  });
  const androidHeaderActions = useMemo<ReadonlyArray<AppBarAction>>(() => {
    const actions: AppBarAction[] = [];
    if (props.onReturnToThread) {
      actions.push({
        accessibilityLabel: "Return to chat",
        icon: "chevron.left",
        onPress: props.onReturnToThread,
      });
    }
    if (props.hasThreadCwd) {
      const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
      actions.push({
        accessibilityLabel: filesVisible ? "Close files" : "Open files",
        selected: filesVisible,
        icon: "folder",
        onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
      });
    }
    if (props.hasWorkspaceRoot && props.gitControls.canOpenTerminal) {
      actions.push({
        accessibilityLabel: "Open terminal",
        icon: "terminal",
        onPress: () => onOpenTerminal(null),
      });
    }
    actions.push({
      accessibilityLabel: "Open git controls",
      icon: "point.topleft.down.curvedto.point.bottomright.up",
      onPress: props.onOpenGitInspector,
    });
    if (onMergeBack) {
      actions.push({
        accessibilityLabel: "Merge back to source",
        icon: PullRequestGlyph.merged,
        onPress: onMergeBack,
      });
    }
    return actions;
  }, [
    props.inspectorMode,
    panes.auxiliaryPaneVisible,
    props.onOpenFilesInspector,
    onOpenTerminal,
    onMergeBack,
    props.onOpenGitInspector,
    toggleAuxiliaryPane,
    props.onReturnToThread,
    props.hasThreadCwd,
    props.hasWorkspaceRoot,
    props.gitControls.canOpenTerminal,
  ]);

  return (
    <>
      {usesFloatingThreadControls(layout) ? (
        <>
          <ThreadFloatingTopScrim />
          <ThreadFloatingHeader hidden={composerKeyboardActive} />
        </>
      ) : (
        <AppBar
          title={props.title}
          subtitle={props.subtitle}
          sidebar={native.sidebar}
          options={native.options}
          optionsVersion={native.optionsVersion}
          trailing={
            !layout.usesSplitView ? (
              <ScreenHeaderButton
                accessibilityLabel="Open thread details"
                icon="sidebar.right"
                selected={details.open}
                onPress={details.openDrawer}
              />
            ) : props.fileInspectorSupported && props.hasThreadCwd ? (
              <ScreenHeaderButton
                accessibilityLabel={
                  props.inspectorMode !== null && panes.auxiliaryPaneVisible
                    ? "Hide inspector"
                    : "Show inspector"
                }
                icon="sidebar.right"
                selected={props.inspectorMode !== null && panes.auxiliaryPaneVisible}
                onPress={props.onToggleInspector}
              />
            ) : null
          }
          onBack={layout.usesSplitView ? undefined : goBack}
          actions={androidHeaderActions}
          hideBottomBorder
          compact={composerKeyboardActive}
        />
      )}
      {layout.usesSplitView ? native.fallback : null}
      <ThreadDetailsDrawer
        title={props.title}
        workspace={props.workspace}
        gitControls={props.gitControls}
        onCloseThread={goBack}
        onReturnToThread={props.onReturnToThread}
      />
    </>
  );
}
