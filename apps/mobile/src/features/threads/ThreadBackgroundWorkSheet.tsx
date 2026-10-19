import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  presentPendingBackgroundWork,
  type PendingBackgroundWorkItem,
} from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { ScreenStack } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import { environmentThreadShells } from "../../state/threads";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
const LABEL_LINES = 2;

type BackgroundWorkTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

const KIND_LABELS: Record<PendingBackgroundWorkItem["kind"], string> = {
  subagent: "Subagent",
  command: "Command",
  monitor: "Monitor",
  background_task: "Background task",
};

export function ThreadBackgroundWorkSheet({ route }: StaticScreenProps<BackgroundWorkTarget>) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const thread = useAtomValue(
    environmentThreadShells.threadShellAtom(scopeThreadRef(target.environmentId, target.threadId)),
  );
  const items = presentPendingBackgroundWork(thread?.pendingBackgroundTasks ?? [])?.items ?? [];

  const openChildThread = (childThreadId: ThreadId) => {
    void Haptics.selectionAsync();
    // Same as the agents sheet: the child thread belongs in the workspace stack, not above a leaf sheet.
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: target.environmentId,
        threadId: childThreadId,
      }),
    );
  };

  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {items.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          Nothing running in the background.
        </Text>
      ) : (
        items.map((item) => (
          <BackgroundWorkRow key={item.taskId} item={item} onOpen={openChildThread} />
        ))
      )}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-background-work-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            {content}
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              title="Background work"
              titleColorClassName="accent-foreground"
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader title="Background work" onBack={() => navigation.goBack()} />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}

function BackgroundWorkRow(props: {
  readonly item: PendingBackgroundWorkItem;
  readonly onOpen: (childThreadId: ThreadId) => void;
}) {
  const { item } = props;
  const childThreadId = item.childThreadId;
  const [labelLineCount, setLabelLineCount] = useState(0);
  const [expanded, setExpanded] = useState(false);
  // An untitled command is labeled with its raw input, which can be a whole script, so long
  // labels stay clamped until tapped. Subagent rows open their thread instead.
  const canExpand = childThreadId === undefined && labelLineCount > LABEL_LINES;
  const row = (
    <View className="flex-row items-center gap-3 border-b border-border py-3.5">
      <SymbolView
        name={
          item.kind === "subagent"
            ? "person.2"
            : item.kind === "monitor"
              ? { ios: "bolt", android: "bolt" }
              : "terminal"
        }
        size={15}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
      <View className="min-w-0 flex-1">
        <Text
          className="font-t3-medium text-sm text-foreground"
          numberOfLines={canExpand && expanded ? undefined : LABEL_LINES}
        >
          {item.label}
        </Text>
        <Text className="text-xs text-foreground-muted">{KIND_LABELS[item.kind]}</Text>
        {childThreadId === undefined ? (
          // A clamped Text reports only its visible lines, so an unclamped copy measures overflow.
          <Text
            aria-hidden
            onTextLayout={(event) => setLabelLineCount(event.nativeEvent.lines.length)}
            className="absolute inset-x-0 top-0 -z-[1] font-t3-medium text-sm opacity-0"
          >
            {item.label}
          </Text>
        ) : null}
      </View>
      {childThreadId !== undefined ? (
        <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
      ) : canExpand ? (
        <SymbolView
          name={expanded ? "chevron.up" : "chevron.down"}
          size={12}
          tintColorClassName="accent-icon-subtle"
        />
      ) : null}
    </View>
  );

  if (childThreadId === undefined) {
    if (!canExpand) return <View accessible>{row}</View>;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityHint={expanded ? "Shortens the name" : "Shows the full name"}
        onPress={() => setExpanded((current) => !current)}
        className="active:opacity-70"
      >
        {row}
      </Pressable>
    );
  }
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityHint="Opens this subagent's thread"
      onPress={() => props.onOpen(childThreadId)}
      className="active:opacity-70"
    >
      {row}
    </Pressable>
  );
}
