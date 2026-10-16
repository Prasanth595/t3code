import { type RunId, type ThreadId } from "@t3tools/contracts";
import {
  isProviderEventStreamFailure,
  hasAcceptedProviderTurn,
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Threads from "./ThreadManagementService.ts";

/** One automatic continuation of saved native history; another failure requires the user. */
export const continueProviderStream = Effect.fn(
  "ProviderStreamContinuation.continueProviderStream",
)(function* (input: { readonly threadId: ThreadId; readonly sourceRunId: RunId }) {
  const threads = yield* Threads.ThreadManagementService;
  const records = yield* threads.getThreadRecords(
    input.threadId,
    ["runs", "providerThreads", "providerTurns", "turnItems", "runtimeRequests"],
    {
      turnItemRunIds: [input.sourceRunId],
      turnItemTypes: ["error", "secret_request", "run_interrupt_request"],
    },
  );
  const source = latestExecutedRun(records.runs);
  const thread = records.thread;
  if (
    source?.id !== input.sourceRunId ||
    source.status !== "failed" ||
    !hasAcceptedProviderTurn(source, records.providerTurns) ||
    thread.deletedAt !== null ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    (thread.snoozedUntil != null &&
      DateTime.isGreaterThan(thread.snoozedUntil, yield* DateTime.now)) ||
    !isProviderEventStreamFailure(latestRootProviderFailure(source, records.turnItems)) ||
    source.userMessageId.startsWith("message:codex-retry:") ||
    records.runtimeRequests.some((request) => request.status === "pending") ||
    records.turnItems.some(
      (item) =>
        item.type === "run_interrupt_request" ||
        (item.type === "secret_request" && item.secretStatus === "pending"),
    )
  )
    return;
  const native = records.providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  if (
    native?.driver !== "codex" ||
    native.nativeThreadRef?.strength !== "strong" ||
    native.providerInstanceId !== source.providerInstanceId ||
    thread.modelSelection.instanceId !== source.providerInstanceId
  )
    return;
  const original = yield* threads.getThreadRecords(input.threadId, ["messages"], {
    messageIds: [source.userMessageId],
  });
  const message = original.messages.find((candidate) => candidate.id === source.userMessageId);
  if (message === undefined || message.text.trimStart().startsWith("/")) return;
  // Reconnection uses the saved native id. Admission rechecks the latest failed
  // run under the thread lock, so a new user submission always takes precedence.
  yield* threads.restartCodex({
    threadId: input.threadId,
    retryRunId: input.sourceRunId,
    automatic: true,
  });
});
