import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "./ThreadManagementService.ts";

export class ThreadLifecycleError extends Schema.TaggedError<ThreadLifecycleError>()(
  "ThreadLifecycleError",
  {
    operation: Schema.Literals([
      "archive",
      "unarchive",
      "delete",
      "update-metadata",
      "set-runtime-mode",
      "set-interaction-mode",
      "set-model-selection",
    ]),
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread lifecycle operation '${this.operation}' failed for ${this.threadId}.`;
  }
}

export class ThreadLifecycleService extends Context.Service<
  ThreadLifecycleService,
  {
    readonly archive: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly unarchive: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly delete: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly updateMetadata: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly title?: string;
      readonly branch?: string | null;
      readonly worktreePath?: string | null;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly setRuntimeMode: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly runtimeMode: RuntimeMode;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly setInteractionMode: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly interactionMode: ProviderInteractionMode;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly setModelSelection: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly modelSelection: ModelSelection;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
  }
>()("t3/orchestration-v2/ThreadLifecycleService") {}

/**
 * Transitive subagent children of the thread, parent before child. A shell is
 * a subagent child when its lineage says so; forks are not descendants and
 * never expand. The visited set guards against lineage cycles.
 */
const subagentDescendantIds = (
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  threadId: ThreadId,
): ReadonlyArray<ThreadId> => {
  const childIdsByParentId = new Map<ThreadId, Array<ThreadId>>();
  for (const shell of shells) {
    const { parentThreadId, relationshipToParent } = shell.lineage;
    if (relationshipToParent !== "subagent" || parentThreadId === null) continue;
    const childIds = childIdsByParentId.get(parentThreadId) ?? [];
    childIds.push(shell.id);
    childIdsByParentId.set(parentThreadId, childIds);
  }
  const descendants: Array<ThreadId> = [];
  const visited = new Set<ThreadId>([threadId]);
  const pending = [threadId];
  while (pending.length > 0) {
    const parentId = pending.shift();
    if (parentId === undefined) break;
    for (const childId of childIdsByParentId.get(parentId) ?? []) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      descendants.push(childId);
      pending.push(childId);
    }
  }
  return descendants;
};

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;

  const dispatch = <Operation extends ThreadLifecycleError["operation"]>(
    operation: Operation,
    threadId: ThreadId,
    command: Parameters<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>[0],
  ) =>
    threads.dispatch(command).pipe(
      Effect.andThen(threads.getThreadRecords(threadId, [])),
      Effect.mapError((cause) => new ThreadLifecycleError({ operation, threadId, cause })),
    );

  /**
   * Dispatches the command to every transitive subagent descendant of the
   * target thread. The caller dispatches the target itself last, so a
   * descendant failure leaves the target untouched. Archiving walks the
   * active shells, unarchiving the archived ones.
   */
  const dispatchToSubagentDescendants = (
    operation: "archive" | "unarchive",
    input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    },
    dispatchDescendant: (descendantId: ThreadId) => Effect.Effect<unknown, ThreadLifecycleError>,
  ) =>
    Effect.gen(function* () {
      const location = operation === "archive" ? "active" : "archive";
      const snapshot = yield* threads
        .getShellSnapshot({ location })
        .pipe(
          Effect.mapError(
            (cause) => new ThreadLifecycleError({ operation, threadId: input.threadId, cause }),
          ),
        );
      const shells = location === "active" ? snapshot.threads : snapshot.archivedThreads;
      for (const descendantId of subagentDescendantIds(shells, input.threadId)) {
        yield* dispatchDescendant(descendantId);
      }
    });

  return ThreadLifecycleService.of({
    archive: (input) =>
      dispatchToSubagentDescendants("archive", input, (descendantId) =>
        dispatch("archive", descendantId, {
          type: "thread.archive",
          commandId: CommandId.make(`${input.commandId}:${descendantId}`),
          threadId: descendantId,
        }),
      ).pipe(
        Effect.andThen(
          dispatch("archive", input.threadId, {
            type: "thread.archive",
            commandId: input.commandId,
            threadId: input.threadId,
          }),
        ),
      ),
    unarchive: (input) =>
      dispatchToSubagentDescendants("unarchive", input, (descendantId) =>
        dispatch("unarchive", descendantId, {
          type: "thread.unarchive",
          commandId: CommandId.make(`${input.commandId}:${descendantId}`),
          threadId: descendantId,
        }),
      ).pipe(
        Effect.andThen(
          dispatch("unarchive", input.threadId, {
            type: "thread.unarchive",
            commandId: input.commandId,
            threadId: input.threadId,
          }),
        ),
      ),
    delete: (input) =>
      dispatch("delete", input.threadId, {
        type: "thread.delete",
        commandId: input.commandId,
        threadId: input.threadId,
      }),
    updateMetadata: (input) =>
      dispatch("update-metadata", input.threadId, {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
      }),
    setRuntimeMode: (input) =>
      dispatch("set-runtime-mode", input.threadId, {
        type: "thread.runtime-mode.set",
        commandId: input.commandId,
        threadId: input.threadId,
        runtimeMode: input.runtimeMode,
      }),
    setInteractionMode: (input) =>
      dispatch("set-interaction-mode", input.threadId, {
        type: "thread.interaction-mode.set",
        commandId: input.commandId,
        threadId: input.threadId,
        interactionMode: input.interactionMode,
      }),
    setModelSelection: (input) =>
      dispatch("set-model-selection", input.threadId, {
        type: "thread.model-selection.set",
        commandId: input.commandId,
        threadId: input.threadId,
        modelSelection: input.modelSelection,
      }),
  });
});

export const layer = Layer.effect(ThreadLifecycleService, make);
