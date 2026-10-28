import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { ScreenStack } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { startScheduledTaskEditor } from "../settings/scheduled-task-editor-state";
import { editDraft } from "../settings/scheduledTaskDraft";
import {
  describeScheduledTaskSchedule,
  formatNextScheduledTaskRun,
} from "../settings/scheduledTaskPresentation";
import { openSettings } from "../settings/settings-navigation";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type AutomationsTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

/** Scheduled tasks whose runs post into this thread. */
export function useThreadAutomations(target: AutomationsTarget | null) {
  const tasks = useEnvironmentQuery(
    target === null
      ? null
      : serverEnvironment.scheduledTasksLive({ environmentId: target.environmentId, input: {} }),
  );
  return {
    tasks: tasks.data?.tasks.filter((task) => task.threadId === target?.threadId) ?? [],
    loaded: tasks.data !== null,
    error: tasks.error,
  };
}

export function ThreadAutomationsSheet({ route }: StaticScreenProps<AutomationsTarget>) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const target = route.params;
  const environmentId = target.environmentId;
  const automations = useThreadAutomations(target);
  const environmentLabel =
    useEnvironmentPresentation(environmentId).presentation?.entry.target.label ?? "";
  const [now, setNow] = useState(Date.now);
  useFocusEffect(
    useCallback(() => {
      setNow(Date.now());
      const timer = setInterval(() => setNow(Date.now()), 60_000);
      return () => clearInterval(timer);
    }, []),
  );
  const canOperate = useAtomValue(
    serverEnvironment.runScheduledTaskNow.permissionAtom(environmentId),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "thread automation toggle",
    reportFailure: false,
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "thread automation run now",
    reportFailure: false,
  });

  const edit = (task: ScheduledTask) => {
    startScheduledTaskEditor({ environmentId, environmentLabel, draft: editDraft(task) });
    openSettings(navigation, "SettingsScheduledTaskEdit");
  };
  const act = async (task: ScheduledTask, action: "run" | "toggle") => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const result =
      action === "run"
        ? await runNow({ environmentId, input: { id: task.id } })
        : await setEnabled({ environmentId, input: { id: task.id, enabled: !task.enabled } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(
        action === "run" ? "Could not run automation" : "Could not update automation",
        String(squashAtomCommandFailure(result)),
      );
    }
  };

  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {automations.error ? (
        <Text className="pt-6 text-center text-sm text-danger-foreground">
          Could not load automations: {automations.error}
        </Text>
      ) : !automations.loaded ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">Loading automations…</Text>
      ) : automations.tasks.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          No automations run in this thread.
        </Text>
      ) : (
        automations.tasks.map((task) => (
          <AutomationRow
            key={task.id}
            task={task}
            now={now}
            canOperate={canOperate}
            onEdit={edit}
            onAction={(action) => void act(task, action)}
          />
        ))
      )}
      <Pressable
        accessibilityRole="link"
        onPress={() => openSettings(navigation, "SettingsScheduledTasks")}
        className="items-center py-4 active:opacity-70"
      >
        <Text className="font-t3-medium text-sm text-foreground-secondary">
          Manage scheduled tasks
        </Text>
      </Pressable>
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
            screenId="thread-automations-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            {content}
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              title="Automations"
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
      <AndroidSheetHeader title="Automations" onBack={() => navigation.goBack()} />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}

function AutomationRow(props: {
  readonly task: ScheduledTask;
  readonly now: number;
  readonly canOperate: boolean;
  readonly onEdit: (task: ScheduledTask) => void;
  readonly onAction: (action: "run" | "toggle") => void;
}) {
  const { task } = props;
  const running = task.lastRunStatus === "running";
  return (
    <View className="flex-row items-start gap-3 border-b border-border py-3.5">
      <SymbolView
        name="calendar.badge.clock"
        size={15}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Edit ${task.title}`}
        onPress={() => props.onEdit(task)}
        className="min-w-0 flex-1 gap-0.5 active:opacity-70"
      >
        <Text className="font-t3-medium text-sm text-foreground" numberOfLines={1}>
          {task.title}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={2}>
          {describeScheduledTaskSchedule(task)}
          {running
            ? " · Running"
            : !task.enabled
              ? " · Paused"
              : task.nextRunAt
                ? ` · ${formatNextScheduledTaskRun(task.nextRunAt, props.now)}`
                : ""}
        </Text>
        {task.lastRunError ? (
          <Text className="text-xs text-danger-foreground" numberOfLines={2}>
            Last run failed: {task.lastRunError}
          </Text>
        ) : null}
      </Pressable>
      <Menu
        actions={[
          { id: "edit", title: "Edit" },
          {
            id: "toggle",
            title: task.enabled ? "Pause" : "Resume",
            attributes: { disabled: !props.canOperate },
          },
          // Webhook tasks run only on a request to their URL.
          ...(task.schedule.type === "webhook"
            ? []
            : [
                {
                  id: "run",
                  title: "Run now",
                  attributes: { disabled: !props.canOperate || running },
                },
              ]),
        ]}
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event === "edit") props.onEdit(task);
          else if (nativeEvent.event === "toggle" || nativeEvent.event === "run") {
            props.onAction(nativeEvent.event);
          }
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Actions for ${task.title}`}
          className="-my-2.5 h-11 w-11 items-center justify-center"
        >
          <SymbolView
            name="ellipsis"
            size={18}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
        </Pressable>
      </Menu>
    </View>
  );
}
