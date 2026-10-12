import {
  CommonActions,
  StackActions,
  useFocusEffect,
  useNavigation,
} from "@react-navigation/native";
import { useCallback } from "react";
import { BackHandler, Keyboard, Platform } from "react-native";
import { androidWorkspaceNavigationState } from "../../lib/android-workspace-navigation";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";

export function useWorkspaceListNavigation(tab: WorkspaceTab) {
  const navigation = useNavigation();
  const dispatch = useWorkspaceTabs()?.dispatch;
  return useCallback(() => {
    if (Platform.OS === "android") {
      dispatch?.({ type: "select", tab });
      navigation.dispatch((state) => CommonActions.reset(androidWorkspaceNavigationState(state)));
    } else if (navigation.canGoBack()) navigation.goBack();
    else navigation.dispatch(StackActions.replace("Home"));
  }, [navigation, dispatch, tab]);
}

/** Switching Android workspace tabs closes the open detail, as each tab owns its own. */
export function useSelectAndroidWorkspaceTab() {
  const navigation = useNavigation();
  const workspace = useWorkspaceTabs();
  const selectedTab = workspace?.state.selectedTab;
  const dispatch = workspace?.dispatch;
  return useCallback(
    (tab: WorkspaceTab) => {
      Keyboard.dismiss();
      if (tab === selectedTab) return;
      dispatch?.({ type: "select", tab });
      navigation.dispatch((state) => CommonActions.reset(androidWorkspaceNavigationState(state)));
    },
    [navigation, dispatch, selectedTab],
  );
}

/** Only base details own this Back handler; focused sheets and nested screens take priority. */
export function useAndroidWorkspaceBack(tab: WorkspaceTab) {
  const dispatch = useWorkspaceTabs()?.dispatch;
  const returnToList = useWorkspaceListNavigation(tab);
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return;
      dispatch?.({ type: "select", tab });
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (Keyboard.isVisible()) Keyboard.dismiss();
        else returnToList();
        return true;
      });
      return () => subscription.remove();
    }, [returnToList, dispatch, tab]),
  );
  return returnToList;
}
