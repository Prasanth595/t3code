import { useNavigation, useNavigationState } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import { BackHandler, Keyboard, View, type TextInputInstance } from "react-native";
import { AndroidHeaderIconButton } from "../../components/ui/AndroidScreenHeader";
import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { SearchField } from "../../components/ui/SearchField";
import { useToolbarLayout } from "../../components/ui/useToolbarLayout";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { WorkspaceListToolbarRow } from "../workspace/WorkspaceListToolbarRow";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { WORKSPACE_TAB_PRESENTATION } from "../workspace/workspace-tabs-state";
import { usePullRequestFilterMenu } from "./PullRequestFilterMenuContext";

/** PR search shares the thread list's Android header row. */
export function PullRequestToolbar(props: { readonly onRequestVisibility?: () => void }) {
  const navigation = useNavigation();
  const filters = usePullRequestFilterMenu();
  const workspace = useWorkspaceTabs()!;
  const { dispatch, getScrollOffset, recordScrollOffset, isTabActive } = workspace;
  const homeFocused = useNavigationState((state) => state.routes[state.index]?.name === "Home");
  const tabId = workspace.state.selectedTab;
  const presentation = WORKSPACE_TAB_PRESENTATION[tabId];
  const listFocused = homeFocused && tabId !== "threads";
  const { onRequestVisibility } = props;
  const tab = workspace.state.tabs[tabId];
  const input = useRef<TextInputInstance>(null);
  const searching = tab.searchMode !== "resting";
  const openSearch = useCallback(() => {
    onRequestVisibility?.();
    dispatch({ type: "scroll", tab: tabId, offset: getScrollOffset(tabId) });
    dispatch({ type: "search", tab: tabId });
    input.current?.focus();
    return true;
  }, [dispatch, getScrollOffset, onRequestVisibility, tabId]);
  useHardwareKeyboardCommand("focusSearch", openSearch);
  const closeSearch = useCallback(() => {
    Keyboard.dismiss();
    recordScrollOffset(tabId, tab.searchEntryOffset);
    dispatch({ type: "cancel", tab: tabId });
  }, [dispatch, recordScrollOffset, tab.searchEntryOffset, tabId]);
  useEffect(() => {
    if (!searching || !listFocused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      // Frozen Home screens can keep effects alive after a detail route opens.
      const state = navigation.getState();
      if (!state || state.routes[state.index]?.name !== "Home" || !isTabActive(tabId)) return false;
      if (Keyboard.isVisible()) Keyboard.dismiss();
      else closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [searching, closeSearch, listFocused, navigation, isTabActive, tabId]);
  const { paddingTop, paddingBottom } = useToolbarLayout();
  return (
    <View className="bg-header px-2" style={{ paddingTop, paddingBottom }}>
      <WorkspaceListToolbarRow
        searching={searching}
        searchField={
          <SearchField
            inputRef={input}
            accessibilityLabel={presentation.search}
            clearAccessibilityLabel="Clear search"
            placeholder={presentation.search}
            value={tab.query}
            onChangeText={(query) => dispatch({ type: "query", tab: tabId, query })}
          />
        }
        onCloseSearch={closeSearch}
        onOpenSearch={openSearch}
        searchAccessibilityLabel={presentation.search}
        titleAccessibilityLabel={`T3 Code, ${presentation.title}`}
        onOpenEnvironments={() =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "SettingsEnvironments" },
          })
        }
        filter={
          tabId === "pullRequests" && filters ? (
            <AndroidAnchoredMenu
              actions={filters.actions}
              onPressAction={({ nativeEvent }) => filters.onSelect(nativeEvent.event)}
            >
              {(open) => (
                <AndroidHeaderIconButton
                  accessibilityLabel="Filter pull requests"
                  icon={
                    filters.customized
                      ? "line.3.horizontal.decrease.circle.fill"
                      : "line.3.horizontal.decrease.circle"
                  }
                  onPress={open}
                />
              )}
            </AndroidAnchoredMenu>
          ) : null
        }
      />
    </View>
  );
}
