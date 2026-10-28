import {
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { AlarmClockIcon } from "lucide-react";
import { useState } from "react";

import {
  useComposerDraftStore,
  type ComposerThreadTarget,
  type DraftId,
} from "~/composerDraftStore";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { stackedThreadToast, toastManager } from "../ui/toast";

function localDateTimeInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function failureText(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not schedule the message.";
}

export function ScheduleSendControl(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  readonly draftId: DraftId | null;
  readonly composerTarget: ComposerThreadTarget;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly hasAttachments: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState(() => localDateTimeInput(new Date(Date.now() + 60 * 60 * 1000)));
  const [saving, setSaving] = useState(false);
  const draftSession = useComposerDraftStore((state) =>
    props.draftId === null ? undefined : state.draftThreadsByThreadKey[props.draftId],
  );
  const createMessage = useAtomCommand(serverEnvironment.scheduleMessageCreate, {
    reportFailure: false,
  });
  const cancelMessage = useAtomCommand(serverEnvironment.scheduleMessageCancel, {
    reportFailure: false,
  });
  const live = useEnvironmentQuery(
    serverEnvironment.scheduledMessagesLive({
      environmentId: props.environmentId,
      input: {},
    }),
  );
  const pending = (live.data?.messages ?? []).filter((message) => {
    if (message.status !== "pending" && message.status !== "failed") return false;
    if (props.threadId !== null) return message.threadId === props.threadId;
    return message.threadId === null && message.projectId === props.projectId;
  });
  const workspaceStrategy = workspaceForDraft(draftSession);

  const schedule = async () => {
    const prompt = props.prompt.trim();
    if (prompt.length === 0 || props.hasAttachments || saving) return;
    const sendAt = new Date(when);
    if (Number.isNaN(sendAt.getTime())) {
      toastManager.add(stackedThreadToast({ type: "error", title: "Choose a real time." }));
      return;
    }
    setSaving(true);
    const result = await createMessage({
      environmentId: props.environmentId,
      input: {
        prompt,
        sendAt: sendAt.toISOString(),
        projectId: props.projectId,
        threadId: props.threadId,
        workspaceStrategy: props.threadId === null ? workspaceStrategy : { type: "root" },
        modelSelection: props.modelSelection,
        runtimeMode: props.runtimeMode,
        interactionMode: props.interactionMode,
        createdBy: "user",
        creationSource: "web",
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not schedule the message",
          description: failureText(squashAtomCommandFailure(result)),
        }),
      );
      return;
    }
    useComposerDraftStore.getState().clearComposerContent(props.composerTarget);
    setOpen(false);
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Message scheduled",
        description: sendAt.toLocaleString(),
      }),
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label="Send later" />}
        disabled={props.prompt.trim().length === 0}
      >
        <AlarmClockIcon />
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" width="sm" className="flex flex-col gap-3 p-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Send later</p>
          <p className="text-xs text-muted-foreground">
            {props.hasAttachments
              ? "Files and images stay on this device. Remove them to schedule the text."
              : "The message text sends at this time. Files and images are not included."}
          </p>
        </div>
        <input
          type="datetime-local"
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value={when}
          min={localDateTimeInput(new Date(Date.now() + 60_000))}
          onChange={(event) => setWhen(event.target.value)}
        />
        <Button size="sm" disabled={props.hasAttachments || saving} onClick={() => void schedule()}>
          Schedule
        </Button>
        {pending.length > 0 ? (
          <ul className="flex flex-col gap-2 border-t pt-2">
            {pending.map((message) => (
              <li key={message.id} className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block truncate text-xs">{message.prompt}</span>
                  <span className="text-xs text-muted-foreground">
                    {message.status === "failed"
                      ? (message.error ?? "Could not send")
                      : new Date(message.sendAt).toLocaleString()}
                  </span>
                </span>
                {message.status === "pending" ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      void cancelMessage({
                        environmentId: props.environmentId,
                        input: { id: message.id },
                      })
                    }
                  >
                    Cancel
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

function workspaceForDraft(
  session:
    | {
        readonly envMode: string;
        readonly branch: string | null;
        readonly worktreePath: string | null;
        readonly startFromOrigin: boolean;
      }
    | undefined,
): OrchestrationV2ThreadLaunchWorkspaceStrategy {
  if (session?.envMode === "worktree" && session.worktreePath) {
    return {
      type: "existing_worktree",
      worktreePath: session.worktreePath,
      ...(session.branch ? { branch: session.branch } : {}),
    };
  }
  if (session?.envMode === "worktree" && session.branch) {
    return {
      type: "worktree",
      baseRef: session.branch,
      ...(session.startFromOrigin ? { startFromOrigin: true } : {}),
    };
  }
  return session?.branch ? { type: "root", branch: session.branch } : { type: "root" };
}
