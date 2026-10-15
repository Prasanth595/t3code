/**
 * Fork: `recoverInterruptedTurns`. Restart recovery sends each thread that a
 * restart or crash cut off the configured message, so its agent continues.
 *
 * It builds on the upstream restart continuation (`RestartContinuation.ts`):
 * the same outbox effect carries the cut run, and this module decides what to
 * send when the switch is on. It adds two things upstream does not do:
 *  - it wakes a thread whose turn had finished but whose background shells
 *    the restart killed (upstream wakes it only for other background work);
 *  - it never sends a second message after a recovery turn that a restart
 *    cut before it gave an answer.
 * It keeps the upstream limits: the chain cap and a project that turned
 * continuation off.
 */
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  MessageId,
  RunId,
  type OrchestrationV2Run,
  type ProjectId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { isNativeMaintenanceCommand } from "./Orchestrator.ts";
import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";
import {
  isRestartContinuationSource,
  isRestartNoteSource,
  restartCancelledBackgroundWorkNote,
  restartContinuationNote,
} from "./RestartBackgroundNote.ts";
import { MAX_CONTINUATION_CHAIN, restartContinuationBlocked } from "./RestartContinuation.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const MESSAGE_ID_PREFIX = "message:recover-interrupted:";

/** A project that turned continuation off keeps its threads asleep, with this switch on too. */
export const projectTurnedContinuationOff = (
  settings: ServerSettings,
  projectId: ProjectId | null,
) => {
  const project = resolveProjectSettings(settings, projectId);
  return (
    project.sources.continueThreadsAfterServerUpdate === "project" &&
    !project.settings.continueThreadsAfterServerUpdate
  );
};

const isOpenStatus = (status: string) =>
  status === "pending" || status === "running" || status === "waiting";

/** The user put the thread away, so a restart leaves it asleep, as upstream does. */
const isThreadPutAway = (
  thread: Pick<
    ProjectionRuntimeRecoveryState["thread"],
    "archivedAt" | "deletedAt" | "settledOverride" | "snoozedUntil"
  >,
  now: DateTime.Utc,
) =>
  thread.archivedAt !== null ||
  thread.deletedAt !== null ||
  thread.settledOverride === "settled" ||
  (thread.snoozedUntil != null && DateTime.isGreaterThan(thread.snoozedUntil, now));

/**
 * The thread's latest run when its turn had finished but its own provider
 * thread still had background work open. The restart kills that work, so the
 * agent never hears back from it. Upstream wakes these threads only for work
 * other than shells, and only with a live session.
 */
export function settledRunWithOpenBackgroundWork(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    "thread" | "runs" | "providerThreads" | "turnItems"
  >,
  now: DateTime.Utc,
): OrchestrationV2Run | undefined {
  if (isThreadPutAway(projection.thread, now)) return;
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

/** The run that a restart recovery run continues, from upstream or from this module. */
const recoveredRunId = (run: OrchestrationV2Run): RunId | undefined =>
  run.restartContinuationOfRunId ??
  (run.userMessageId.startsWith(MESSAGE_ID_PREFIX)
    ? RunId.make(run.userMessageId.slice(MESSAGE_ID_PREFIX.length))
    : undefined);

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
    ["messages", "runs", "providerTurns", "attempts", "runtimeRequests", "turnItems"],
    { messageIds: [messageId], turnItemTypes: ["secret_request"] },
  );
  const now = yield* DateTime.now;
  if (isThreadPutAway(projection.thread, now)) return;
  if (projectTurnedContinuationOff(settings, projection.thread.projectId)) return;
  // One message per cut run, so one per thread for each server start.
  if (projection.messages.some((message) => message.id === messageId)) return;
  const source = projection.runs.find((run) => run.id === input.sourceRunId);
  if (!source) return;
  // A finished turn whose background work the restart killed.
  const settled = isRestartNoteSource(source, projection.providerTurns);
  // Otherwise only a turn that recovery cancelled mid-way, and only when
  // upstream would continue it too: its provider turn did not end on its own
  // and the user owes no answer.
  if (
    !settled &&
    (source.status !== "cancelled" || restartContinuationBlocked(projection, source, now, false))
  )
    return;
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
  // A turn that keeps restarting the server, such as a deploy, would otherwise recover forever.
  let chainLength = 0;
  let previousRunId = recoveredRunId(source);
  while (previousRunId !== undefined && chainLength < MAX_CONTINUATION_CHAIN) {
    chainLength += 1;
    const previous = previousRunId;
    const run = projection.runs.find((candidate) => candidate.id === previous);
    previousRunId = run === undefined ? undefined : recoveredRunId(run);
  }
  if (chainLength >= MAX_CONTINUATION_CHAIN) {
    yield* Effect.logWarning("Not recovering a run restarted too many times in a row", {
      threadId: input.threadId,
      sourceRunId: input.sourceRunId,
    });
    return;
  }
  // No loop: a recovery turn that a restart cut before any answer gets no second message.
  if (recoveredRunId(source) !== undefined) {
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
  // The project turned this instance off since the restart. No turn resumes,
  // and the caller still recovers a delegated child, as upstream does.
  const dispatch = (command: Parameters<typeof threads.dispatch>[0]) =>
    threads.dispatch(command).pipe(
      Effect.catchTags({
        ThreadManagementProviderInstanceDisabledError: (error) =>
          Effect.logInfo("orchestration-v2.recover-interrupted.instance-disabled", {
            threadId: input.threadId,
            sourceRunId: input.sourceRunId,
            projectId: error.projectId,
            instanceId: error.instanceId,
          }),
      }),
    );
  // A finished turn that lost only shells. Upstream does not continue it, so a
  // new turn on the same provider thread wakes it. Turn start puts the note
  // about the killed background work in front of this text.
  if (settled && !isRestartContinuationSource(source, projection.providerTurns)) {
    yield* dispatch({
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
  // A continuation of the cut turn, or of a finished turn that lost awaited
  // work, as upstream sends it, with the configured text. The continuation
  // link keeps a delegated task and `t3_thread_wait` on the new run.
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
  yield* dispatch({
    type: "message.dispatch",
    commandId,
    threadId: input.threadId,
    messageId,
    text,
    notification: {
      source: { kind: "system" },
      outcome: "updated",
      summary: settled
        ? "T3 Code restarted and stopped background work"
        : "T3 Code restarted and resumed this turn",
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
