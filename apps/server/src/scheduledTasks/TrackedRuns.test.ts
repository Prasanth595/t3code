import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { makeTrackedRuns } from "./TrackedRuns.ts";

const taskId = ScheduledTaskId.make("task:tracked");
const threadId = ThreadId.make("thread:tracked");
const messageId = MessageId.make("message:tracked");
const epoch = DateTime.makeUnsafe(0);

const runEvent = (
  runId: string,
  status: "queued" | "running" | "completed" | "failed" | "cancelled",
  userMessageId = messageId,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${runId}:${status}`),
  type: "run.updated",
  threadId,
  runId: RunId.make(runId),
  occurredAt: epoch,
  payload: {
    id: RunId.make(runId),
    threadId,
    ordinal: 1,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    providerThreadId: null,
    userMessageId,
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: epoch,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  },
});

it("holds an outcome that lands during the dispatch until the dispatch returns", () => {
  const runs = makeTrackedRuns();
  runs.track(messageId, taskId, "start");
  assert.deepEqual(runs.observe(runEvent("run:fast", "failed")), []);
  assert.deepEqual(runs.dispatched(messageId), {
    taskId,
    startedAtIso: "start",
    status: "failed",
    error: "The run failed.",
  });
  assert.isNull(runs.dispatched(messageId));
});

it("ignores the end of a queued run whose message was promoted into the active run", () => {
  const runs = makeTrackedRuns();
  runs.track(messageId, taskId, "start");
  runs.dispatched(messageId);
  assert.deepEqual(runs.observe(runEvent("run:queued", "queued")), []);
  runs.observe({
    id: EventId.make("event:promoted"),
    type: "message.updated",
    threadId,
    runId: RunId.make("run:active"),
    occurredAt: epoch,
    payload: {
      id: messageId,
      threadId,
      runId: RunId.make("run:active"),
      nodeId: null,
      role: "user",
      text: "Run the audit",
      attachments: [],
      streaming: false,
      createdAt: epoch,
      updatedAt: epoch,
      createdBy: "user",
      creationSource: "web",
    },
  });
  assert.deepEqual(runs.observe(runEvent("run:queued", "cancelled")), []);
  assert.deepEqual(runs.observe(runEvent("run:active", "completed")), [
    { taskId, startedAtIso: "start", status: "succeeded", error: null },
  ]);
});

it("fails a run whose thread is deleted before the turn ends", () => {
  const runs = makeTrackedRuns();
  runs.track(messageId, taskId, "start");
  runs.dispatched(messageId);
  runs.observe(runEvent("run:orphaned", "running"));
  assert.deepEqual(
    runs.observe({
      id: EventId.make("event:deleted"),
      type: "thread.deleted",
      threadId,
      occurredAt: epoch,
      payload: undefined as never,
    }),
    [{ taskId, startedAtIso: "start", status: "failed", error: "The thread was deleted." }],
  );
});
