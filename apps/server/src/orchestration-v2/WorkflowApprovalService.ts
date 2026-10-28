/**
 * The person's decision on a reviewed graph: the gate records it, then a canned `user` message
 * from the `server` source tells the agent. It is not a typed request, so the turn trigger never
 * reads it as one.
 */
import {
  CommandId,
  MessageId,
  OrchestrationV2WorkflowApprovalError,
  type OrchestrationV2ApproveWorkflowReviewInput,
  type OrchestrationV2DismissWorkflowReviewInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as WorkflowApprovalGate from "./WorkflowApprovalGate.ts";

export class WorkflowApprovalService extends Context.Service<
  WorkflowApprovalService,
  {
    readonly approve: (
      input: OrchestrationV2ApproveWorkflowReviewInput,
    ) => Effect.Effect<void, OrchestrationV2WorkflowApprovalError>;
    readonly dismiss: (
      input: OrchestrationV2DismissWorkflowReviewInput,
    ) => Effect.Effect<void, OrchestrationV2WorkflowApprovalError>;
  }
>()("t3/orchestration-v2/WorkflowApprovalService") {}

const approvedText = (digest: string) =>
  `I approved the workflow graph you reviewed (digest ${digest}). Start it now: call graph_start with that graph and acceptedDigest ${digest}. If you no longer have the graph, use the expandedGraph from that review.`;

const dismissedText =
  "I dismissed the workflow graph you reviewed. Do not start a workflow for this request.";

const make = Effect.gen(function* () {
  const gate = yield* WorkflowApprovalGate.WorkflowApprovalGate;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  /**
   * Ids come from the request and the gate's decision id, so a repeated click or retry is the
   * same command and is answered from its receipt. A decision made after a restart has a new
   * decision id, so an earlier receipt never answers it.
   */
  const tellAgent = (
    input: OrchestrationV2ApproveWorkflowReviewInput | OrchestrationV2DismissWorkflowReviewInput,
    decision: "approved" | "dismissed",
    key: string,
    text: string,
  ) => {
    return threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:workflow-${decision}:${key}`),
        threadId: input.threadId,
        messageId: MessageId.make(`message:workflow-${decision}:${key}`),
        text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new OrchestrationV2WorkflowApprovalError({
              threadId: input.threadId,
              reviewId: input.reviewId,
              reason: "unavailable",
              cause,
            }),
        ),
      );
  };

  return WorkflowApprovalService.of({
    approve: Effect.fn("WorkflowApprovalService.approve")(function* (input) {
      const { request, decisionId } = yield* gate.approve(input);
      yield* tellAgent(
        input,
        "approved",
        `${input.threadId}:${request}:${decisionId}`,
        approvedText(input.digest),
      );
    }),
    dismiss: Effect.fn("WorkflowApprovalService.dismiss")(function* (input) {
      const { request, decisionId } = yield* gate.dismiss(input);
      // One word to the agent per dismissal, however many of the request's reviews are dismissed.
      yield* tellAgent(
        input,
        "dismissed",
        `${input.threadId}:${request}:${decisionId}`,
        dismissedText,
      );
    }),
  });
});

export const layer = Layer.effect(WorkflowApprovalService, make);
