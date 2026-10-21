import { useAtomValue } from "@effect/atom-react";
import {
  isWatchTask,
  watchActivityLabel,
  watchSourceLabel,
  watchStatus,
  type ScheduledTaskWithWatch,
} from "@t3tools/client-runtime/scheduled-task-watch";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { createDraft, editDraft, type ScheduledTaskDraft } from "../settings/scheduledTaskDraft";
import { startScheduledTaskEditor } from "../settings/scheduled-task-editor-state";

export function ThreadWatchersSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId } = props;
  const navigation = useNavigation();
  const thread = useThreadShell({ environmentId, threadId: props.threadId });
  const environmentLabel =
    useEnvironmentPresentation(environmentId).presentation?.entry.target.label ?? "";
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const canOperate = useAtomValue(
    serverEnvironment.runScheduledTaskNow.permissionAtom(environmentId),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "thread watcher enabled",
    reportFailure: false,
  });
  const checkNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "thread watcher check",
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "thread watcher stop",
    reportFailure: false,
  });
  const actionInFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const watchers = (tasks.data?.tasks ?? []).filter(
    (task): task is ScheduledTaskWithWatch => task.threadId === props.threadId && isWatchTask(task),
  );
  const canCreate = canOperate && thread !== null && tasks.data?.supportsWatchers === true;
  if (watchers.length === 0 && !canCreate) return null;

  const openEditor = (draft: ScheduledTaskDraft) => {
    startScheduledTaskEditor({ environmentId, environmentLabel, draft });
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "SettingsScheduledTaskEdit" },
    });
  };
  const newWatcher = () => {
    if (!thread) return;
    const draft = createDraft(thread.projectId, thread.modelSelection);
    openEditor({
      ...draft,
      threadId: thread.id,
      modelSelectionIsExplicit: true,
      runtimeMode: thread.runtimeMode,
      schedule: { ...draft.schedule, mode: "watch", intervalMinutes: "5" },
    });
  };

  const act = async (task: ScheduledTaskWithWatch, action: "toggle" | "run" | "delete") => {
    if (
      actionInFlight.current ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    )
      return;
    actionInFlight.current = true;
    setBusy(true);
    const result =
      action === "run"
        ? await checkNow({ environmentId, input: { id: task.id } })
        : action === "toggle"
          ? await setEnabled({ environmentId, input: { id: task.id, enabled: !task.enabled } })
          : await remove({ environmentId, input: { id: task.id } });
    actionInFlight.current = false;
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(
        `Could not ${{ run: "check", toggle: "update", delete: "stop" }[action]} watcher`,
        String(squashAtomCommandFailure(result)),
      );
    }
  };

  return (
    <ListSection title="Watchers">
      {watchers.map((task, index) => {
        const status = watchStatus(task);
        return (
          <View
            key={task.id}
            className={cn("flex-row items-center", index > 0 && "border-t border-border-subtle")}
          >
            <View className="min-w-0 flex-1">
              <ListRowLayout
                icon="eye"
                label={task.title}
                description={[
                  `${status.label} · ${watchSourceLabel(task.watch.source)}`,
                  task.lastRunError ??
                    [
                      task.lastRunAt ? `Checked ${relativeTime(task.lastRunAt)} ago` : null,
                      watchActivityLabel(task.watch),
                    ]
                      .filter(Boolean)
                      .join(" · "),
                ].join("\n")}
              />
            </View>
            <Menu
              title={task.title}
              actions={[
                { id: "edit", title: "Edit" },
                {
                  id: "toggle",
                  title: task.enabled ? "Pause" : "Resume",
                  attributes: { disabled: !canOperate || busy },
                },
                {
                  id: "run",
                  title: "Check now",
                  attributes: { disabled: !canOperate || !task.enabled || busy },
                },
                {
                  id: "delete",
                  title: "Stop watching",
                  attributes: { destructive: true, disabled: !canOperate || busy },
                },
              ]}
              onPressAction={({ nativeEvent }) => {
                const action = nativeEvent.event;
                if (action === "edit") {
                  openEditor(editDraft(task));
                } else if (action === "delete") {
                  Dialog.alert("Stop watching?", task.title, [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Stop watching",
                      style: "destructive",
                      onPress: () => void act(task, "delete"),
                    },
                  ]);
                } else if (action === "toggle" || action === "run") {
                  void act(task, action);
                }
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Actions for ${task.title}`}
                className="mr-2 h-11 w-11 items-center justify-center"
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
      })}
      {canCreate ? (
        <View className={cn(watchers.length > 0 && "border-t border-border-subtle")}>
          <ListRow
            icon="plus"
            label="New watcher"
            description="Start a run in this thread when an item changes"
            onPress={newWatcher}
          />
        </View>
      ) : null}
    </ListSection>
  );
}
