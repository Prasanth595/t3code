import type {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function getLatestCompletedCheckpointTurnCount(
  checkpoints: ReadonlyArray<
    Pick<
      OrchestrationV2ThreadProjection["checkpoints"][number],
      "status" | "appRunOrdinal" | "runId"
    >
  >,
  runs: ReadonlyArray<Pick<OrchestrationV2ThreadProjection["runs"][number], "id" | "status">>,
): number {
  const completedRunIds = new Set(
    runs.filter((run) => run.status === "completed").map((run) => run.id),
  );
  return checkpoints.reduce(
    (latest, checkpoint) =>
      checkpoint.status === "ready" &&
      checkpoint.runId !== null &&
      completedRunIds.has(checkpoint.runId)
        ? Math.max(latest, checkpoint.appRunOrdinal ?? 0)
        : latest,
    0,
  );
}

export interface ThreadCheckpointSummary {
  readonly checkpointId?: CheckpointId;
  readonly scopeId?: CheckpointScopeId;
  readonly runId: RunId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error" | "stale";
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

export function deriveThreadCheckpointSummaries(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<ThreadCheckpointSummary> {
  return projection.checkpoints.flatMap((checkpoint) => {
    if (checkpoint.appRunOrdinal === null || checkpoint.runId === null) return [];
    const assistantMessageId =
      projection.messages.findLast(
        (message) => message.runId === checkpoint.runId && message.role === "assistant",
      )?.id ?? null;
    return [
      {
        checkpointId: checkpoint.id,
        scopeId: checkpoint.scopeId,
        runId: checkpoint.runId,
        checkpointTurnCount: checkpoint.appRunOrdinal,
        checkpointRef: checkpoint.ref,
        status: checkpoint.status,
        files: checkpoint.files,
        assistantMessageId,
        completedAt: DateTime.formatIso(checkpoint.capturedAt),
      },
    ];
  });
}
