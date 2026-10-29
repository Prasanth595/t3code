import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  NodeId,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { foldedQueuedTurnItems } from "./QueuedRunBatch.ts";
import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

describe("queued run delivery order", () => {
  it("folds a completed batch but excludes its messages after the turn restarts on a new input node", () => {
    const runId = RunId.make("run:batch");
    const originalNodeId = NodeId.make("node:original");
    const restartedNodeId = NodeId.make("node:restarted");
    const input = (
      name: string,
      ordinal: number,
      nodeId: NodeId,
    ): Extract<OrchestrationV2TurnItem, { type: "user_message" }> => ({
      id: TurnItemId.make(`item:${name}`),
      threadId: ThreadId.make("thread:batch"),
      runId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-10-29T00:00:00Z"),
      type: "user_message",
      messageId: MessageId.make(`message:${name}`),
      inputIntent: "queued_turn",
      text: name,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    });
    const first = input("first", 0, originalNodeId);
    const second = input("second", 1, originalNodeId);
    const third = input("third", 2, originalNodeId);
    const batch = [third, first, second];

    expect(foldedQueuedTurnItems(batch, { id: runId, userMessageId: first.messageId })).toEqual([
      second,
      third,
    ]);

    const current = input("current", 3, restartedNodeId);
    expect(
      foldedQueuedTurnItems([...batch, current], {
        id: runId,
        userMessageId: current.messageId,
      }),
    ).toEqual([]);
  });

  it("keeps automatic completion delivery ahead of visible queued messages", () => {
    const projection = {
      messages: [
        { id: "message:visible-first" },
        {
          id: "message:automatic",
          delegatedCompletion: {
            generation: 1,
            parentRunId: "run:parent",
            taskIds: ["task:child"],
          },
        },
        { id: "message:visible-second" },
      ],
      runs: [
        {
          id: "run:visible-first",
          ordinal: 2,
          queuePosition: 1,
          status: "queued",
          userMessageId: "message:visible-first",
        },
        {
          id: "run:automatic",
          ordinal: 4,
          queuePosition: 3,
          status: "queued",
          userMessageId: "message:automatic",
        },
        {
          id: "run:visible-second",
          ordinal: 3,
          queuePosition: 2,
          status: "queued",
          userMessageId: "message:visible-second",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:automatic",
      "run:visible-first",
      "run:visible-second",
    ]);
  });
});
