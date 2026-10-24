import { useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { Keyboard, Platform } from "react-native";

import { resetRootStack } from "../../lib/root-stack-reset";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { currentWorkspaceSelections } from "./workspace-selection-store";
import { workspaceTabNavigationState } from "./workspace-tab-navigation";
import type { WorkspaceTab } from "./workspace-tabs-state";

/** iOS columns show a detail beside the list, so a tab opens with a page in it. */
export function useWorkspaceColumns() {
  const { layout } = useAdaptiveWorkspaceLayout();
  return Platform.OS === "ios" && layout.usesSplitView;
}

/**
 * The one way to open a workspace tab, Settings included: it replaces the root stack with the
 * tab's list and, with columns, the page the tab last showed.
 */
export function useSelectWorkspaceTab() {
  const workspace = useWorkspaceTabs();
  const navigation = useNavigation();
  const columns = useWorkspaceColumns();
  const dispatch = workspace?.dispatch;
  return useCallback(
    (tab: WorkspaceTab | "settings") => {
      Keyboard.dismiss();
      resetRootStack(navigation, (state) =>
        workspaceTabNavigationState(state, tab, currentWorkspaceSelections(), columns),
      );
      if (tab !== "settings") dispatch?.({ type: "select", tab });
    },
    [columns, dispatch, navigation],
  );
}
