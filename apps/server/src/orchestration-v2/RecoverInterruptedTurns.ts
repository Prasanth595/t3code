/**
 * Fork: `recoverInterruptedTurns`. Restart recovery sends each thread that a
 * restart or crash cut off the configured message, so its agent continues.
 *
 * It builds on the upstream restart continuation (`RestartContinuation.ts`):
 * the same outbox effect carries the cut run, and this module decides what to
 * send when the switch is on. It adds two things upstream does not do:
 *  - it wakes a thread whose turn had finished but whose background work
 *    (native subagents, monitors, background shells) the restart killed;
 *  - it never sends a second message after a recovery turn that a restart
 *    cut before it gave an answer.
 */
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type RunId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { isNativeMaintenanceCommand } from "./Orchestrator.ts";
import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";
import {
  isRestartNoteSource,
  restartCancelledBackgroundWorkNote,
  restartContinuationNote,
} from "./RestartBackgroundNote.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const MESSAGE_ID_PREFIX = "message:recover-interrupted:";

const isOpenStatus = (status: string) =>
  status === "pending" || status === "running" || status === "waiting";

/**
 * The thread's latest run when its turn had finished but its own provider
 * thread still had background work open. The restart kills that work, so the
 * agent never hears back from it. Upstream keeps these threads asleep.
 */
export function settledRunWithOpenBackgroundWork(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    "thread" | "runs" | "providerThreads" | "turnItems"
  >,
): OrchestrationV2Run | undefined {
  if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) return;
  const run = projection.runs.reduce<OrchestrationV2Run | undefined>(
    (latest, candidate) =>
      candidate.status !== "queued" && (!latest || runRanAfter(candidate, latest))
        ? candidate
        : latest,
    undefined,
  );
  if (!run || (run.status !== "completed" && run.status !== "waiting")) return;
  if (
    run.providerThreadId === null ||
    run.providerInstanceId !== projection.thread.providerInstanceId
  )
    return;
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  // The message resumes the native conversation; without a saved one it has no context.
  if (providerThread?.nativeThreadRef?.strength !== "strong") return;
  const openItem = projection.turnItems.some(
    (item) =>
      isOpenStatus(item.status) &&
      (item.type === "command_execution" ||
        item.type === "dynamic_tool" ||
        // A delegated child thread is continued on its own and reports back itself.
        (item.type === "subagent" &&
          !(item.origin === "app_owned" && item.childThreadId !== null))) &&
      (item.providerThreadId ??
        projection.runs.find((candidate) => candidate.id === item.runId)?.providerThreadId) ===
        providerThread.id,
  );
  const openRoster =
    providerThread.ownerNodeId === null && (providerThread.pendingBackgroundTasks?.length ?? 0) > 0;
  return openItem || openRoster ? run : undefined;
}

/** A run that a restart recovery started, from upstream or from this module. */
const isRecoveryRun = (run: OrchestrationV2Run) =>
  run.restartContinuationOfRunId !== undefined || run.userMessageId.startsWith(MESSAGE_ID_PREFIX);

/**
 * Sends the recovery message for `sourceRunId`, the run the restart cut off.
 * Called by the `provider-runtime.continue` effect in place of the upstream
 * continuation when `recoverInterruptedTurns` is on.
 */
export const recoverInterruptedThread = Effect.fn(
  "RecoverInterruptedTurns.recoverInterruptedThread",
)(function* (
  input: { readonly threadId: ThreadId; readonly sourceRunId: RunId },
  settings: ServerSettings,
) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const messageId = MessageId.make(`${MESSAGE_ID_PREFIX}${input.sourceRunId}`);
  const projection = yield* threads.getThreadRecords(
    input.threadId,
    ["messages", "runs", "providerTurns", "attempts"],
    { messageIds: [messageId] },
  );
  if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) return;
  // One message per cut run, so one per thread for each server start.
  if (projection.messages.some((message) => message.id === messageId)) return;
  const source = projection.runs.find((run) => run.id === input.sourceRunId);
  if (!source) return;
  // A finished turn whose background work the restart killed.
  const settled = isRestartNoteSource(source, projection.providerTurns);
  // Otherwise only a turn that recovery cancelled mid-way. A completed,
  // failed, or interrupted turn ended on its own.
  if (!settled && source.status !== "cancelled") return;
  // Work started after the restart, such as a new user message, comes first.
  if (
    projection.runs.some(
      (run) => run.id !== source.id && run.status !== "queued" && runRanAfter(run, source),
    )
  )
    return;
  if (projection.thread.providerInstanceId !== source.providerInstanceId) return;
  const sourceRecords = yield* threads.getThreadRecords(input.threadId, ["messages", "turnItems"], {
    messageIds: [source.userMessageId],
    turnItemRunIds: [source.id],
    turnItemTypes: ["run_interrupt_request", "approval_request", "user_input_request"],
  });
  // The user stopped this run on purpose.
  if (sourceRecords.turnItems.some((item) => item.type === "run_interrupt_request")) return;
  // The run waited for an answer or an approval. A "continue" message could
  // read as that answer, so the thread waits for the user instead.
  if (
    sourceRecords.turnItems.some(
      (item) => item.type !== "run_interrupt_request" && item.status !== "completed",
    )
  )
    return;
  const sourceMessage = sourceRecords.messages.find(
    (message) => message.id === source.userMessageId,
  );
  if (sourceMessage !== undefined && isNativeMaintenanceCommand(sourceMessage)) return;
  // No loop: a recovery turn that a restart cut before any answer gets no second message.
  if (isRecoveryRun(source)) {
    const answers = yield* threads.getThreadRecords(input.threadId, ["messages"], {
      messageRunIds: [source.id],
      messageRoles: ["assistant"],
    });
    if (answers.messages.length === 0) return;
  }

  const message =
    projection.thread.lineage.relationshipToParent === "subagent"
      ? settings.recoverInterruptedTurnsSubagentMessage
      : settings.recoverInterruptedTurnsMessage;
  const commandId = CommandId.make(`command:recover-interrupted:${input.sourceRunId}`);
  if (settled) {
    // A new turn on the same provider thread. Turn start puts the note about
    // the killed background work in front of this text.
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId,
      threadId: input.threadId,
      messageId,
      text: message,
      notification: {
        source: { kind: "system" },
        outcome: "updated",
        summary: "T3 Code restarted and stopped background work",
        detail: message,
      },
      attachments: [],
      modelSelection: source.modelSelection,
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
    return;
  }
  // A continuation of the cut turn, as upstream sends it, with the configured text.
  const note = restartContinuationNote(
    source,
    projection.runs,
    projection.providerTurns,
    projection.attempts,
  );
  const text =
    note.work.length === 0
      ? message
      : `${restartCancelledBackgroundWorkNote(note.work)}\n\n${message}`;
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId,
    threadId: input.threadId,
    messageId,
    text,
    notification: {
      source: { kind: "system" },
      outcome: "updated",
      summary: "T3 Code restarted and resumed this turn",
      detail: text,
    },
    attachments: [],
    modelSelection: source.modelSelection,
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
    restartContinuationOfRunId: input.sourceRunId,
  });
});
