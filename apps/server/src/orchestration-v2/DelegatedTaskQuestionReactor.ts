import { CommandId, MessageId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { reportLabel } from "@t3tools/provider-core/server/notification";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * Wakes the parent of an app-owned delegated task when the task asks a question. The question
 * blocks the task until someone answers it, and the user rarely watches child threads, so the
 * parent agent is told to answer it or to ask the user. Only questions are routed: approvals
 * cannot be answered through the pending request tools.
 */
export class DelegatedTaskQuestionReactor extends Context.Service<
  DelegatedTaskQuestionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/DelegatedTaskQuestionReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const handle: DelegatedTaskQuestionReactor["Service"]["handle"] = (event) =>
    Effect.gen(function* () {
      if (
        event.type !== "runtime-request.updated" ||
        event.payload.kind !== "user_input" ||
        event.payload.status !== "pending"
      ) {
        return;
      }
      const childRecords = yield* projections.getThreadRecords(event.threadId, ["runtimeRequests"]);
      const child = childRecords.thread;
      const parentThreadId = child.lineage.parentThreadId;
      if (
        childRecords.runtimeRequests.find((request) => request.id === event.payload.id)?.status !==
          "pending" ||
        child.lineage.relationshipToParent !== "subagent" ||
        parentThreadId === null ||
        child.forkedFrom?.type !== "node"
      ) {
        return;
      }
      const taskId = child.forkedFrom.nodeId;
      const parent = yield* projections.getThreadRecords(parentThreadId, ["subagents"]);
      const task = parent.subagents.find(
        (candidate) =>
          candidate.id === taskId &&
          candidate.origin === "app_owned" &&
          candidate.childThreadId === child.id,
      );
      if (
        task === undefined ||
        parent.thread.archivedAt !== null ||
        parent.thread.deletedAt !== null ||
        parent.thread.settledOverride === "settled" ||
        parent.thread.settledAt !== null
      ) {
        return;
      }
      const label = reportLabel(task.title?.trim() || task.prompt);
      // Keyed by the request, so a request updated while still pending wakes the parent once.
      const key = `${parentThreadId}:${event.payload.id}`;
      const situation =
        event.payload.responseCapability.type === "message"
          ? `Delegated task ${taskId} asked a question and is still working.`
          : `Delegated task ${taskId} is blocked on a question and cannot continue until it is answered.`;
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:delegated-task-question:${key}`),
        threadId: parentThreadId,
        messageId: MessageId.make(`message:delegated-task-question:${key}`),
        text: `${situation} Read it with t3_pending_request_list and t3_pending_request_read using threadId ${child.id}. Answer it with t3_pending_request_respond when the answer follows from the task or the user's instructions; otherwise ask the user, then answer it. If it is no longer pending, it was answered or dismissed.`,
        notification: {
          source: { kind: "delegated_task", taskIds: [taskId], childThreadId: child.id },
          outcome: "updated",
          summary: `Delegated task${label === undefined ? "" : ` "${label}"`} has a question`,
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("waking the parent of a delegated task question failed", {
          threadId: event.threadId,
          error,
        }),
      ),
    );

  const start: DelegatedTaskQuestionReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated task question event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies DelegatedTaskQuestionReactor["Service"];
});

export const layer = Layer.effect(DelegatedTaskQuestionReactor, make);
