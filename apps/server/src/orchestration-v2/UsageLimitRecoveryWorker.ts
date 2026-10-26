import {
  CommandId,
  MessageId,
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type OrchestrationV2Command,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { modelIdentitiesEqual } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * The next model an ordered chain offers a usage-limited thread. Everything up to and
 * including the failed run's own selection is skipped, so a chain whose fallback is
 * itself limited advances instead of retrying the same model, and a run the chain does
 * not name starts at its head.
 */
export function limitFallbackSelection(
  runModelSelection: ModelSelection,
  chain: ReadonlyArray<ModelSelection>,
  isInstanceEnabled: (instanceId: ProviderInstanceId) => boolean,
): ModelSelection | null {
  // Options do not create a new quota, so a chain entry for the limited model is that model.
  const failedAt = chain.findIndex((entry) => modelIdentitiesEqual(entry, runModelSelection));
  return (
    chain
      .slice(failedAt + 1)
      .find(
        (entry) =>
          !modelIdentitiesEqual(entry, runModelSelection) && isInstanceEnabled(entry.instanceId),
      ) ?? null
  );
}

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

/**
 * A configured chain is the opt-in itself, so a limited thread continues at once on the
 * next chain entry instead of waiting for the window to reset. The selection moves first:
 * that is what opens the target provider thread and carries the context handoff, and the
 * continuation then names the selection the thread already carries.
 */
export function limitFallbackCommands(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  fallback: ModelSelection,
  nowMs: number,
): readonly [OrchestrationV2Command, OrchestrationV2Command] | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${fallback.instanceId}:${fallback.model}`;
  return [
    {
      type: "thread.model-selection.set",
      commandId: CommandId.make(`limit-fallback-switch:${identity}`),
      threadId: thread.id,
      modelSelection: fallback,
    },
    {
      type: "message.dispatch",
      commandId: CommandId.make(`limit-fallback:${identity}`),
      messageId: MessageId.make(`limit-fallback:${identity}`),
      threadId: thread.id,
      usageLimitContinuationOfRunId: thread.latestRunId,
      text: "Continue where you left off.",
      attachments: [],
      modelSelection: fallback,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    },
  ];
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    // A configured chain is its own opt-in, so ask for the limited threads that the
    // resume-at-reset policy alone would leave out.
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume:
        preferences.autoResumeLimitedThreads || preferences.usageLimitFallbackChain.length > 0,
      snooze: preferences.snoozeLimitedThreads,
    });
    const nowMs = DateTime.toEpochMillis(now);
    /** Accepted tells a caller that depends on this command's effect whether it may continue. */
    const send =
      (threadId: ProjectionStore.ProjectionLimitRecoveryCandidate["id"]) =>
      (command: OrchestrationV2Command): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
            yield* orchestrator.autoArmLimitRecovery({
              commandId: command.commandId,
              threadId: command.threadId,
              limitRecovery: command.limitRecovery,
            });
          } else {
            yield* threads.dispatch(command);
          }
        }).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
              threadId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
    for (const thread of candidates) {
      const dispatch = send(thread.id);
      const fallback = limitFallbackSelection(
        thread.runModelSelection,
        preferences.usageLimitFallbackChain,
        (instanceId) =>
          resolveProjectProviderInstanceEnabled(preferences, thread.projectId, instanceId),
      );
      const commands = fallback === null ? null : limitFallbackCommands(thread, fallback, nowMs);
      if (commands !== null) {
        const [moveSelection, continueOnFallback] = commands;
        // Only continue when the thread really carries the fallback: a selection that never
        // landed would make the continuation stale, and resuming at the reset is the safer
        // leftover.
        if (yield* dispatch(moveSelection)) {
          yield* dispatch(continueOnFallback);
          continue;
        }
      }
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
      yield* dispatch(command);
    }
  });
});

/** One pass over every limited thread, shared by the scheduler source and by tests. */
export const sweep = makeSweep.pipe(Effect.flatMap((run) => run()));

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep);
  }),
);
