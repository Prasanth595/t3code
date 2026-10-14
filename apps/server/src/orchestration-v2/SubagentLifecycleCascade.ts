import { CommandId, type OrchestrationV2AppThread, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

export type SubagentLifecycleOperation = "archive" | "unarchive" | "delete";

export class SubagentLifecycleCascade extends Context.Service<
  SubagentLifecycleCascade,
  {
    readonly cascade: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly operation: SubagentLifecycleOperation;
    }) => Effect.Effect<
      void,
      | OrchestratorV2Error
      | ThreadManagementService.ThreadManagementProviderInstanceDisabledError
      | ProjectionStore.ProjectionStoreV2Error
      | CommandReceiptStore.CommandReceiptStoreV2Error
    >;
  }
>()("t3/orchestration-v2/SubagentLifecycleCascade") {}

/**
 * The outbox effect a lifecycle command commits whenever its thread has
 * eligible subagent children, including deleted intermediates for deletion.
 * It is committed even when every child already
 * looks done: a pending cascade from an earlier command has not reached the
 * projection yet, and a child already in the state can still have subagents
 * that are not.
 *
 * Archive and delete queue this before the thread's native cleanup so descendant
 * lifecycle commands and their cleanup can be queued without waiting for its
 * provider teardown. Child cleanup and deeper cascades run in their own outbox
 * lanes; this walk must not await those effects. Descendant command locks can
 * still delay the walk and this thread's cleanup.
 */
export function subagentLifecycleCascadeEffect(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly operation: SubagentLifecycleOperation;
}): PendingOrchestrationEffectV2 {
  return {
    id: `effect:${input.commandId}:subagent-threads.cascade`,
    commandId: input.commandId,
    threadId: input.threadId,
    request: { type: "subagent-threads.cascade", operation: input.operation },
  };
}

function reachedState(thread: OrchestrationV2AppThread, operation: SubagentLifecycleOperation) {
  if (thread.deletedAt !== null) return true;
  switch (operation) {
    case "archive":
      return thread.archivedAt !== null;
    case "unarchive":
      return thread.archivedAt === null;
    case "delete":
      return false;
  }
}

/**
 * Runs a conversation's archive, unarchive, or delete on its subagent threads.
 * Each child that still needs the change gets the same command a client would
 * send, so its runs, provider sessions and terminals are handled exactly like
 * the parent's, and its own cascade effect carries the change further down. A
 * child already in the target state is left alone, but the walk continues into
 * its subagents, which may not be. Forks are independent conversations and are
 * never followed.
 *
 * Child command ids derive from the parent command, so a retried effect
 * replays their receipts instead of repeating the work. A stored rejection
 * would replay the same way forever, so a rejected id is followed by
 * `<id>:retry:1`, `:retry:2`, ... The first of those that is unused or accepted
 * is the child's command id, both for its dispatch and as the prefix of its
 * subagents' ids, which keeps them equal to the ids its own cascade uses.
 */
const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const cascadeSubagentLifecycle: SubagentLifecycleCascade["Service"]["cascade"] = (input) => {
    const { operation } = input;
    const commandIdFrom = (
      derived: CommandId,
      replacement = 0,
    ): Effect.Effect<CommandId, CommandReceiptStore.CommandReceiptStoreV2Error> => {
      const id = replacement === 0 ? derived : CommandId.make(`${derived}:retry:${replacement}`);
      return receipts
        .getByCommandId(id)
        .pipe(
          Effect.flatMap((receipt) =>
            Option.isSome(receipt) && receipt.value.status === "rejected"
              ? commandIdFrom(derived, replacement + 1)
              : Effect.succeed(id),
          ),
        );
    };
    const cascade = projections
      .getSubagentChildThreads(input.threadId, { includeDeleted: operation === "delete" })
      .pipe(
        Effect.flatMap((children) =>
          Effect.forEach(
            children,
            (child) => {
              const derived = CommandId.make(`${input.commandId}:subagent:${child.id}`);
              const descend = commandIdFrom(derived).pipe(
                Effect.flatMap((commandId) =>
                  cascadeSubagentLifecycle({ ...input, commandId, threadId: child.id }),
                ),
              );
              if (reachedState(child, operation)) return descend;
              return commandIdFrom(derived).pipe(
                Effect.flatMap((commandId) =>
                  threads.dispatch({ type: `thread.${operation}`, commandId, threadId: child.id }),
                ),
                Effect.asVoid,
                // A concurrent command may have already moved the child, which
                // rejects this one. Only a child still short of the state fails.
                Effect.catch((cause) =>
                  projections
                    .getThread(child.id)
                    .pipe(
                      Effect.flatMap((current) =>
                        !reachedState(current, operation)
                          ? Effect.fail(cause)
                          : current.deletedAt === null || operation === "delete"
                            ? descend
                            : Effect.void,
                      ),
                    ),
                ),
              );
            },
            { discard: true },
          ),
        ),
        Effect.withSpan("SubagentLifecycleCascade.cascade"),
      );
    if (operation === "delete") return cascade;
    // Recursive walks run in the ancestor's outbox lane. Serialize each parent
    // with its commands so an older walk cannot outlive that parent's Undo.
    return executor.withLock(
      input.threadId,
      projections
        .getThread(input.threadId)
        .pipe(
          Effect.flatMap((parent) =>
            parent.deletedAt === null && reachedState(parent, operation) ? cascade : Effect.void,
          ),
        ),
    );
  };
  return SubagentLifecycleCascade.of({ cascade: cascadeSubagentLifecycle });
});

export const layer = Layer.effect(SubagentLifecycleCascade, make);
