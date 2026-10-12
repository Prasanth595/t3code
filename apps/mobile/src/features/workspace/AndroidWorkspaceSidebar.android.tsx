import { useMemo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { PullRequestsScreen } from "../pull-requests/PullRequestsScreen";
import { MaterialPullRequestToolbar } from "../pull-requests/MaterialPullRequestToolbar.android";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { androidWorkspaceNavigationColors } from "./android-workspace-navigation-colors";
import { useSelectAndroidWorkspaceTab } from "./useAndroidWorkspaceNavigation";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";

const TABS: ReadonlyArray<{ id: WorkspaceTab; label: string; icon: AppSymbolName }> = [
  { id: "threads", label: "Chats", icon: "text.bubble" },
  { id: "pullRequests", label: "Pull requests", icon: "arrow.triangle.pull" },
];

// The extended New thread FAB is about 2.6 FAB heights wide at every text size.
const NEW_THREAD_FAB_WIDTH_IN_FABS = 2.6;

/** Floats opposite the New thread FAB, and rises to the filter row when they would collide. */
function WorkspaceTabSwitch(props: { readonly sidebarWidth: number }) {
  const workspace = useWorkspaceTabs()!;
  const selectTab = useSelectAndroidWorkspaceTab();
  const insets = useSafeAreaInsets();
  const { fabSize, iconSize } = useAndroidControlSizing();
  const { themeVariables: colors } = useAppearancePreferences();
  const { containerColor, indicatorColor, selectedColor, unselectedColor } =
    androidWorkspaceNavigationColors(colors, true);
  // Both clusters sit 20dp from the edges with a 12dp gap; the switch is about two FABs wide.
  const fitsBesideNewThread =
    props.sidebarWidth >= 52 + fabSize * (2 + NEW_THREAD_FAB_WIDTH_IN_FABS);
  const fabBaseline = Math.max(insets.bottom, 12) + 6;
  return (
    <View
      accessibilityRole="tablist"
      className="absolute left-5 z-[5] flex-row gap-1 rounded-2xl p-1"
      style={{
        bottom: fitsBesideNewThread ? fabBaseline : fabBaseline + fabSize + 8,
        height: fabSize,
        backgroundColor: containerColor,
        elevation: 6,
      }}
    >
      {TABS.map((tab) => {
        const selected = workspace.state.selectedTab === tab.id;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected }}
            android_ripple={{ color: indicatorColor }}
            onPress={() => selectTab(tab.id)}
            className="items-center justify-center overflow-hidden rounded-xl"
            style={{
              width: fabSize - 8,
              backgroundColor: selected ? indicatorColor : undefined,
            }}
          >
            <SymbolView
              name={tab.icon}
              size={iconSize}
              tintColor={selected ? selectedColor : unselectedColor}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

export function AndroidWorkspaceSidebar(props: {
  readonly children: ReactNode;
  readonly onRequestVisibility: () => void;
  readonly selectedPullRequestKey: string | null;
}) {
  const workspace = useWorkspaceTabs()!;
  const context = useMemo(() => ({ ...workspace, bottomClearance: 16 }), [workspace]);
  const [width, setWidth] = useState<number | null>(null);
  return (
    <View className="flex-1" onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {workspace.state.selectedTab === "threads" ? (
        props.children
      ) : (
        <WorkspaceTabsContext value={context}>
          <View className="flex-1 bg-header">
            <MaterialPullRequestToolbar onRequestVisibility={props.onRequestVisibility} />
            <MaterialScreenContent insetHorizontal>
              <PullRequestsScreen sidebar selectedPullRequestKey={props.selectedPullRequestKey} />
            </MaterialScreenContent>
          </View>
        </WorkspaceTabsContext>
      )}
      {width !== null ? <WorkspaceTabSwitch sidebarWidth={width} /> : null}
    </View>
  );
}
