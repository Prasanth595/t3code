import type {
  OrchestrationV2Notification,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";

export type BackgroundWorkKind = OrchestrationV2PendingBackgroundTask["kind"];

/** What a background work row knows about its work before the tool call lookup. */
export interface BackgroundWorkRef {
  readonly kind: BackgroundWorkKind;
  readonly description: string | undefined;
  readonly taskId: string | undefined;
  /** The provider tool call that started the work. */
  readonly toolUseId: string | undefined;
  readonly childThreadId: ThreadId | undefined;
  readonly outputFile: string | undefined;
}

export interface BackgroundWorkDetails {
  readonly kind: BackgroundWorkKind;
  readonly description: string | undefined;
  /** The command a monitor or shell runs, or the prompt an agent got. */
  readonly definition: string | undefined;
  readonly outputFile: string | undefined;
}

const BACKGROUND_WORK_KIND_LABELS: Record<BackgroundWorkKind, string> = {
  subagent: "Agent",
  command: "Shell command",
  monitor: "Monitor",
  background_task: "Background task",
};

export function backgroundWorkFromPendingTask(
  task: OrchestrationV2PendingBackgroundTask,
): BackgroundWorkRef {
  return {
    kind: task.kind,
    description: task.description,
    taskId: task.taskId,
    toolUseId: undefined,
    childThreadId: task.kind === "subagent" ? task.childThreadId : undefined,
    outputFile: undefined,
  };
}

/** The work a notification reports, or null when it does not report background work. */
export function backgroundWorkFromNotification(
  notification: OrchestrationV2Notification,
): ReadonlyArray<BackgroundWorkRef> | null {
  const source = notification.source;
  switch (source.kind) {
    case "subagent":
    case "command":
    case "monitor":
    case "background_task": {
      const kind = source.kind;
      const childThreadId = source.kind === "subagent" ? source.childThreadId : undefined;
      const tasks = notification.tasks ?? [];
      // Notifications stored before they named their tasks still show their kind and summary.
      if (tasks.length === 0) {
        return [
          {
            kind,
            description: undefined,
            taskId: undefined,
            toolUseId: undefined,
            childThreadId,
            outputFile: undefined,
          },
        ];
      }
      return tasks.map((task) => ({
        kind,
        description: undefined,
        taskId: task.taskId,
        toolUseId: task.toolUseId,
        childThreadId: tasks.length === 1 ? childThreadId : undefined,
        outputFile: task.outputFile,
      }));
    }
    case "delegated_task":
    case "system":
      return null;
    default:
      source satisfies never;
      return null;
  }
}

function stringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" && field.trim().length > 0 ? field : undefined;
}

/**
 * The turn item that started the work: the tool call named by `toolUseId`, a
 * tool whose output names the task (a Claude Monitor returns `{ taskId }`), a
 * turn item whose own id is the task id, or the agent's subagent item.
 */
function findBackgroundWorkStart(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  ref: Pick<BackgroundWorkRef, "taskId" | "toolUseId" | "childThreadId">,
): OrchestrationV2TurnItem | undefined {
  return turnItems.findLast((item) => {
    const nativeId = item.nativeItemRef?.nativeId ?? undefined;
    if (nativeId !== undefined && (nativeId === ref.toolUseId || nativeId === ref.taskId)) {
      return true;
    }
    if (ref.taskId !== undefined && item.type === "dynamic_tool") {
      return stringField(item.output, "taskId") === ref.taskId;
    }
    return (
      ref.childThreadId !== undefined &&
      item.type === "subagent" &&
      item.childThreadId === ref.childThreadId
    );
  });
}

function startDescription(item: OrchestrationV2TurnItem): string | undefined {
  if (item.type === "dynamic_tool") return stringField(item.input, "description");
  return item.title?.trim() || undefined;
}

function startDefinition(item: OrchestrationV2TurnItem): string | undefined {
  switch (item.type) {
    case "command_execution":
      return item.input.trim() || undefined;
    case "subagent":
      return item.prompt.trim() || undefined;
    case "dynamic_tool": {
      const command = stringField(item.input, "command");
      if (command !== undefined) return command;
      if (item.input === null || item.input === undefined) return undefined;
      return JSON.stringify(item.input, null, 2);
    }
    default:
      return undefined;
  }
}

export function resolveBackgroundWorkDetails(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  ref: BackgroundWorkRef,
): BackgroundWorkDetails {
  const start = findBackgroundWorkStart(turnItems, ref);
  return {
    kind: ref.kind,
    description: ref.description ?? (start === undefined ? undefined : startDescription(start)),
    definition: start === undefined ? undefined : startDefinition(start),
    outputFile: ref.outputFile,
  };
}

/** A code fence longer than any backtick run in `code`, so the code cannot close it. */
function fence(code: string): string {
  let longest = 0;
  let run = 0;
  for (const character of code) {
    run = character === "`" ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/** The details as chat markdown, so links, the command, and the output file act as in chat. */
export function backgroundWorkDetailsMarkdown(details: BackgroundWorkDetails): string {
  const blocks = [`**${BACKGROUND_WORK_KIND_LABELS[details.kind]}**`];
  if (details.description !== undefined) blocks.push(details.description);
  if (details.definition !== undefined) {
    const marker = fence(details.definition);
    const language = details.kind === "subagent" ? "text" : "sh";
    blocks.push(`${marker}${language}\n${details.definition}\n${marker}`);
  }
  // Inline code turns an absolute path into the chat's file link, with its open actions.
  // Limit: a path that contains a backtick shows as plain text; revisit if a provider writes one.
  if (details.outputFile !== undefined) {
    blocks.push(
      details.outputFile.includes("`")
        ? `Output: ${details.outputFile}`
        : `Output: \`${details.outputFile}\``,
    );
  }
  return blocks.join("\n\n");
}
