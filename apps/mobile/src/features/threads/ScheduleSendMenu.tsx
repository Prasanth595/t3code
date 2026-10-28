import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type ProjectId,
  type ProviderInteractionMode,
  ScheduledMessageId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { useRef } from "react";
import { Alert } from "react-native";

import { ComposerActionButton } from "../../components/ComposerToolbar";
import { Menu } from "../../components/ui/Menu";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
  type ComposerDraftWorkspaceSelection,
} from "../../state/use-composer-drafts";

function sendAtForPreset(preset: "hour" | "three-hours" | "tomorrow"): string {
  const when = new Date();
  if (preset === "hour") when.setHours(when.getHours() + 1);
  else if (preset === "three-hours") when.setHours(when.getHours() + 3);
  else {
    when.setDate(when.getDate() + 1);
    when.setHours(9, 0, 0, 0);
  }
  return when.toISOString();
}

function workspaceForSelection(
  selection: ComposerDraftWorkspaceSelection | undefined,
): OrchestrationV2ThreadLaunchWorkspaceStrategy {
  if (selection?.mode === "worktree" && selection.worktreePath) {
    return {
      type: "existing_worktree",
      worktreePath: selection.worktreePath,
      ...(selection.branch ? { branch: selection.branch } : {}),
    };
  }
  if (selection?.mode === "worktree" && selection.branch) {
    return {
      type: "worktree",
      baseRef: selection.branch,
      ...(selection.startFromOrigin ? { startFromOrigin: true } : {}),
    };
  }
  return selection?.branch ? { type: "root", branch: selection.branch } : { type: "root" };
}

export function ScheduleSendMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  readonly draftKey: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly canSchedule: boolean;
  readonly disabled: boolean;
  readonly size?: "regular" | "large";
}) {
  const createMessage = useAtomCommand(serverEnvironment.scheduleMessageCreate, {
    reportFailure: false,
  });
  const cancelMessage = useAtomCommand(serverEnvironment.scheduleMessageCancel, {
    reportFailure: false,
  });
  const live = useAtomValue(
    serverEnvironment.scheduledMessagesLive({
      environmentId: props.environmentId,
      input: {},
    }),
  );
  const scheduling = useRef(false);
  const messages = live._tag === "Success" ? live.value.messages : [];
  const listed = messages.filter((message) => {
    if (message.status !== "pending" && message.status !== "failed") return false;
    if (props.threadId !== null) return message.threadId === props.threadId;
    return message.threadId === null && message.projectId === props.projectId;
  });

  const schedule = async (preset: "hour" | "three-hours" | "tomorrow") => {
    if (scheduling.current || !props.canSchedule) return;
    const draft = getComposerDraftSnapshot(props.draftKey);
    const prompt = draft.text.trim();
    if (prompt.length === 0) return;
    if (draft.attachments.length > 0) {
      Alert.alert(
        "Attachments stay on this device",
        "Send later schedules the message text. Remove attachments, or send now.",
      );
      return;
    }
    scheduling.current = true;
    try {
      const modelSelection = draft.modelSelection ?? props.modelSelection;
      const result = await createMessage({
        environmentId: props.environmentId,
        input: {
          prompt,
          sendAt: sendAtForPreset(preset),
          projectId: props.projectId,
          threadId: props.threadId,
          workspaceStrategy:
            props.threadId === null
              ? workspaceForSelection(draft.workspaceSelection)
              : { type: "root" },
          modelSelection,
          runtimeMode: draft.runtimeMode ?? props.runtimeMode,
          interactionMode: draft.interactionMode ?? props.interactionMode,
          createdBy: "user",
          creationSource: "mobile",
        },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Could not schedule the message",
          error instanceof Error ? error.message : "Try again in a moment.",
        );
        return;
      }
      const current = getComposerDraftSnapshot(props.draftKey);
      if (current.text.trim() === prompt && current.attachments.length === 0) {
        clearComposerDraftContent(props.draftKey);
      }
    } finally {
      scheduling.current = false;
    }
  };

  if (!props.canSchedule && listed.length === 0) return null;

  return (
    <Menu
      accessibilityLabel="Send later"
      actions={[
        { id: "hour", title: "In 1 hour", attributes: { disabled: !props.canSchedule } },
        {
          id: "three-hours",
          title: "In 3 hours",
          attributes: { disabled: !props.canSchedule },
        },
        {
          id: "tomorrow",
          title: "Tomorrow at 9:00",
          attributes: { disabled: !props.canSchedule },
        },
        ...listed.slice(0, 3).map((message) =>
          message.status === "failed"
            ? {
                id: `failed:${message.id}`,
                title: "Could not send",
                subtitle: message.error ?? "The message could not be sent.",
                attributes: { disabled: true },
              }
            : {
                id: `cancel:${message.id}`,
                title: "Cancel scheduled message",
                subtitle: new Date(message.sendAt).toLocaleString(),
                attributes: { destructive: true },
              },
        ),
      ]}
      onPressAction={({ nativeEvent }) => {
        const action = nativeEvent.event;
        if (action === "hour" || action === "three-hours" || action === "tomorrow") {
          void schedule(action);
          return;
        }
        if (action.startsWith("cancel:")) {
          void cancelMessage({
            environmentId: props.environmentId,
            input: { id: ScheduledMessageId.make(action.slice("cancel:".length)) },
          });
        }
      }}
    >
      <ComposerActionButton
        size={props.size}
        accessibilityLabel="Send later"
        icon="clock"
        disabled={props.disabled}
        onPress={() => {}}
      />
    </Menu>
  );
}
