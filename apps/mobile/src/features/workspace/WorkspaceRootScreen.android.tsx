import { useMemo } from "react";
import { View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { EmptyState } from "../../components/EmptyState";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { HomeRouteScreen } from "../home/HomeRouteScreen";
import { PullRequestsScreen } from "../pull-requests/PullRequestsScreen";
import { MaterialPullRequestToolbar } from "../pull-requests/MaterialPullRequestToolbar.android";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { AndroidWorkspaceNavigation } from "./AndroidWorkspaceNavigation";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import { ANDROID_WORKSPACE_DOCK } from "./workspace-tabs-state";

export function WorkspaceRootScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const workspace = useWorkspaceTabs()!;
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((keyboard) => keyboard.isVisible);
  const { fabSize } = useAndroidControlSizing();
  const bottom = Math.max(insets.bottom, 16) + 16;
  const bottomClearance = bottom + fabSize + 16;
  const context = useMemo(() => ({ ...workspace, bottomClearance }), [workspace, bottomClearance]);

  // Split lists live beside the navigator; Home remains an empty detail pane.
  if (layout.usesSplitView) {
    return workspace.state.selectedTab === "threads" ? (
      <HomeRouteScreen />
    ) : (
      <>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <AndroidScreenHeader title="Pull requests" />
        <View className="flex-1 items-center justify-center px-10">
          <EmptyState
            title="Select a pull request"
            detail="Choose a pull request from the sidebar to review it."
            variant="plain"
          />
        </View>
      </>
    );
  }

  return (
    <WorkspaceTabsContext value={context}>
      <View className="flex-1 bg-header">
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <View className="flex-1">
          {workspace.state.selectedTab === "threads" ? (
            <HomeRouteScreen />
          ) : (
            <>
              <MaterialPullRequestToolbar />
              <MaterialScreenContent>
                <PullRequestsScreen />
              </MaterialScreenContent>
            </>
          )}
        </View>
        {!keyboardVisible ? (
          <View
            pointerEvents="box-none"
            className="absolute"
            style={{
              bottom,
              left: Math.max(insets.left, ANDROID_WORKSPACE_DOCK.edge),
            }}
          >
            <AndroidWorkspaceNavigation />
          </View>
        ) : null}
      </View>
    </WorkspaceTabsContext>
  );
}
