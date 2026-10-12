import { CommandId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";

import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { isUndeliveredMailboxSteer } from "./NotificationMailbox.ts";

const encodeContinuationFingerprint = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const CONTINUATION_MESSAGE_TEXT = "Background task completed.";

function delegatedCompletionText(taskIds: ReadonlyArray<string>): string {
  const taskList = taskIds.join(", ");
  return taskIds.length === 1
    ? `Delegated task ${taskList} reached a terminal state. Use task_status with taskId ${taskList} to read the result.`
    : `Delegated tasks ${taskList} reached terminal states. Use task_status with each taskId to read the results.`;
}

function currentDelegatedCompletionDelivery(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs" | "providerTurns">,
  completion: NonNullable<
    Extract<
      ProviderContinuationRequests.ProviderContinuationRequest,
      { kind: "delegated_completion" }
    >["delegatedCompletion"]
  >,
) {
  const sourceRun = projection.runs.find((candidate) => candidate.id === completion.parentRunId);
  const delivery = sourceRun?.delegatedCompletion?.delivery;
  const alreadyDispatched = projection.messages.some(
    (message) => message.id === completion.messageId,
  );
  if (
    sourceRun?.delegatedCompletion?.disposition !== "open" ||
    delivery === null ||
    delivery === undefined ||
    delivery.generation !== completion.generation ||
    delivery.messageId !== completion.messageId ||
    (alreadyDispatched && !isUndeliveredMailboxSteer(projection, completion.messageId))
  ) {
    return undefined;
  }
  return delivery;
}

function delegatedCompletionRetryKey(
  request: ProviderContinuationRequests.ProviderContinuationRequest,
  completion: NonNullable<
    Extract<
      ProviderContinuationRequests.ProviderContinuationRequest,
      { kind: "delegated_completion" }
    >["delegatedCompletion"]
  >,
): string {
  return `${request.threadId}:${completion.parentRunId}:${completion.generation}:${completion.messageId}`;
}

/**
 * Drains ProviderContinuationRequests and dispatches an internal
 * message.dispatch per request so the wake turn buffered by the adapter is
 * ingested as a normal run. Delegated completions are durable mailbox offers:
 * the orchestrator selects native steering or queued delivery under its thread
 * lock. Adapter-buffered continuations still queue behind active work.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const retryAttempts = yield* Ref.make(new Map<string, number>());

    const clearRetryAttempt = (key: string) =>
      Ref.update(retryAttempts, (current) => {
        if (!current.has(key)) return current;
        const updated = new Map(current);
        updated.delete(key);
        return updated;
      });

    const nextRetryDelay = (key: string) =>
      Ref.modify(retryAttempts, (current) => {
        const attempt = current.get(key) ?? 0;
        const updated = new Map(current);
        updated.set(key, attempt + 1);
        return [Math.min(100 * 2 ** Math.min(attempt, 6), 5_000), updated] as const;
      });

    const dispatchContinuation = Effect.fn("ProviderContinuationService.dispatchContinuation")(
      function* (request: ProviderContinuationRequests.ProviderContinuationRequest) {
        const projection = yield* threads.getThreadRecords(
          request.threadId,
          request.kind === "delegated_completion" ? ["messages", "runs", "providerTurns"] : [],
          {
            messageIds:
              request.kind !== "delegated_completion"
                ? []
                : [request.delegatedCompletion.messageId],
          },
        );
        if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) {
          yield* Effect.logInfo("orchestration-v2.provider-continuation.thread-archived", {
            threadId: request.threadId,
            providerThreadId: request.providerThreadId,
          });
          if (request.kind === "delegated_completion") {
            yield* clearRetryAttempt(
              delegatedCompletionRetryKey(request, request.delegatedCompletion),
            );
          }
          if (request.kind === "native") yield* request.clearIfCurrent?.() ?? Effect.void;
          return;
        }
        if (request.kind === "delegated_completion") {
          const retryKey = delegatedCompletionRetryKey(request, request.delegatedCompletion);
          const delivery = currentDelegatedCompletionDelivery(
            projection,
            request.delegatedCompletion,
          );
          if (delivery === undefined) {
            yield* clearRetryAttempt(retryKey);
            return;
          }
          const commandId = CommandId.make(
            `delegated-completion:${delivery.messageId}:${isUndeliveredMailboxSteer(projection, delivery.messageId) ? "recovery" : "dispatch"}`,
          );
          yield* threads
            .dispatch({
              type: "message.dispatch",
              commandId,
              threadId: request.threadId,
              messageId: delivery.messageId,
              text: delegatedCompletionText(delivery.taskIds),
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "agent",
              creationSource: "server",
              delegatedCompletion: {
                parentRunId: request.delegatedCompletion.parentRunId,
                generation: delivery.generation,
                taskIds: delivery.taskIds,
              },
            })
            .pipe(
              // The project turned the target instance off between the cohort
              // read above and this dispatch. The finalize that claimed this
              // delivery already wrote the children's results to the parent's
              // history unconditionally, so nothing is lost: acknowledge each
              // task administratively (observedByRunId: null, the same shape
              // task_status uses when no run observed it) to consume this
              // delivery instead of leaving it open to retry. The parent's
              // next turn against an enabled instance reads those results from
              // history the same way any turn does; nothing here re-offers
              // this generation.
              Effect.catchTags({
                ThreadManagementProviderInstanceDisabledError: (error) =>
                  Effect.logInfo(
                    "orchestration-v2.provider-continuation.delegated-completion-disabled",
                    {
                      threadId: request.threadId,
                      projectId: error.projectId,
                      instanceId: error.instanceId,
                    },
                  ).pipe(
                    Effect.andThen(
                      Effect.forEach(
                        delivery.taskIds,
                        (taskId) =>
                          threads.dispatch({
                            type: "delegated_task.completion-delivery.acknowledge",
                            commandId: CommandId.make(
                              `delegated-completion-disabled:${delivery.messageId}:${taskId}`,
                            ),
                            parentThreadId: request.threadId,
                            taskId,
                            observedByRunId: null,
                          }),
                        { discard: true },
                      ),
                    ),
                  ),
              }),
            );
          yield* clearRetryAttempt(retryKey);
          return;
        }
        if (!(yield* request.isCurrent)) {
          yield* request.clearIfCurrent?.() ?? Effect.void;
          return;
        }
        const commandId = CommandId.make(`provider-continuation:${request.messageId}`);
        const cause = {
          kind: "native" as const,
          eventId: request.messageId,
          cause: request.cause,
          delivery: request.delivery,
        };
        const encoded = yield* encodeContinuationFingerprint({
          cause,
          providerThreadId: request.providerThreadId,
          detail: request.detail,
          notification: request.notification,
        }).pipe(Effect.orDie);
        const bytes = yield* crypto
          .digest("SHA-256", new TextEncoder().encode(encoded))
          .pipe(Effect.orDie);
        const intentFingerprint = Array.from(bytes, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        yield* threads
          .dispatch({
            type: "message.causal-dispatch",
            commandId,
            intentFingerprint,
            cause,
            threadId: request.threadId,
            messageId: request.messageId,
            text: request.detail ?? CONTINUATION_MESSAGE_TEXT,
            notification: request.notification ?? {
              source: { kind: "background_task" },
              outcome: "updated",
              summary: "Background activity updated",
            },
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: request.delivery.kind === "adapter_buffered" ? "provider" : "server",
          })
          .pipe(
            Effect.catchTags({
              ThreadManagementProviderInstanceDisabledError: (error) =>
                Effect.logInfo("orchestration-v2.provider-continuation.instance-disabled", {
                  threadId: request.threadId,
                  providerThreadId: request.providerThreadId,
                  projectId: error.projectId,
                  instanceId: error.instanceId,
                }).pipe(Effect.andThen(request.clearIfCurrent?.() ?? Effect.void)),
            }),
          );
      },
    );

    yield* requests.take.pipe(
      Effect.flatMap((request) =>
        dispatchContinuation(request).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("orchestration-v2.provider-continuation.dispatch-failed", {
                threadId: request.threadId,
                providerThreadId: request.providerThreadId,
                cause,
              });
              if (request.kind === "native") yield* request.clearIfCurrent?.() ?? Effect.void;
              if (request.kind === "delegated_completion") {
                const completion = request.delegatedCompletion;
                const retryKey = delegatedCompletionRetryKey(request, completion);
                const retryDelay = yield* nextRetryDelay(retryKey);
                yield* Effect.gen(function* () {
                  yield* Effect.sleep(`${retryDelay} millis`);
                  const projection = yield* threads.getThreadRecords(
                    request.threadId,
                    ["messages", "runs", "providerTurns"],
                    {
                      messageIds:
                        request.kind !== "delegated_completion"
                          ? []
                          : [request.delegatedCompletion.messageId],
                    },
                  );
                  if (currentDelegatedCompletionDelivery(projection, completion) !== undefined) {
                    yield* requests.offer(request);
                  } else {
                    yield* clearRetryAttempt(retryKey);
                  }
                }).pipe(
                  Effect.catchCause((retryCause) =>
                    Effect.logWarning("orchestration-v2.provider-continuation.retry-check-failed", {
                      threadId: request.threadId,
                      providerThreadId: request.providerThreadId,
                      cause: retryCause,
                    }).pipe(Effect.andThen(requests.offer(request))),
                  ),
                  Effect.forkScoped,
                );
              }
            }),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
