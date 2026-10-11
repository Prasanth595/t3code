import type {
  ModelSelection,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";

/**
 * The subset of a projection run that handoff rows read. Kept minimal so the
 * timeline can hold a content-stable snapshot: run status/timestamps churn on
 * every stream event, but these fields only change when a run is added.
 */
export type HandoffTimelineRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "providerInstanceId" | "modelSelection"
>;

export type HandoffEndpoints = ReturnType<typeof resolveHandoffEndpoints>;

/** Preview the next send's handoff without adding anything to durable history. */
export function resolvePendingHandoff(
  projection: OrchestrationV2ThreadProjection | null | undefined,
  selection: ModelSelection | null | undefined,
  providers: ReadonlyArray<ServerProvider>,
): HandoffEndpoints | null {
  if (projection == null || selection == null) return null;
  // A prepared destination can become active before its first turn starts.
  const sourceRun = projection.runs.findLast(
    (run) =>
      run.startedAt !== null && run.providerThreadId !== null && run.status !== "rolled_back",
  );
  const sourceThread = projection.providerThreads.find(
    (thread) =>
      thread.id === (sourceRun?.providerThreadId ?? projection.thread.activeProviderThreadId),
  );
  if (sourceThread?.nativeThreadRef == null && sourceRun === undefined) return null;
  const sourceInstanceId = sourceThread?.providerInstanceId ?? sourceRun?.providerInstanceId;
  if (sourceInstanceId === undefined) return null;
  const sourceSelection = sourceRun?.modelSelection ?? {
    instanceId: sourceInstanceId,
    model:
      projection.thread.modelSelection.instanceId === sourceInstanceId
        ? projection.thread.modelSelection.model
        : undefined,
  };
  const source = providers.find((provider) => provider.instanceId === sourceInstanceId);
  const target = providers.find((provider) => provider.instanceId === selection.instanceId);
  if (sourceInstanceId === selection.instanceId) {
    if (
      sourceSelection.model === selection.model ||
      target?.requiresNewThreadForModelChange !== true
    ) {
      return null;
    }
  } else if (
    sourceThread?.nativeThreadRef != null &&
    source?.driver === target?.driver &&
    source?.continuation?.groupKey !== undefined &&
    source.continuation.groupKey === target?.continuation?.groupKey
  ) {
    return null;
  }
  return { from: [sourceSelection], to: selection };
}

export function resolveHandoffEndpoints(
  item: Pick<
    Extract<OrchestrationV2TurnItem, { type: "handoff" }>,
    "runId" | "fromModelSelections" | "fromProviderInstanceIds" | "toModel" | "toProviderInstanceId"
  >,
  runs: ReadonlyArray<HandoffTimelineRun>,
) {
  // Items persisted before models were stamped only carry instance ids;
  // recover the models from the thread's runs (the handoff's own run is
  // the target, the newest earlier run per source instance is the origin).
  // Clients fall back to the provider display name when neither source has a model.
  const handoffRun = item.runId === null ? undefined : runs.find((run) => run.id === item.runId);
  const toModel =
    item.toModel ??
    (handoffRun !== undefined && handoffRun.providerInstanceId === item.toProviderInstanceId
      ? handoffRun.modelSelection.model
      : undefined);
  const fromEndpoints: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly model?: string | undefined;
  }> =
    item.fromModelSelections !== undefined && item.fromModelSelections.length > 0
      ? item.fromModelSelections
      : item.fromProviderInstanceIds.map((instanceId) => ({
          instanceId,
          model: latestRunModelBefore(runs, instanceId, handoffRun?.ordinal),
        }));
  return { from: fromEndpoints, to: { instanceId: item.toProviderInstanceId, model: toModel } };
}

/**
 * Model of the newest run for `instanceId` that started before the handoff's
 * own run. Legacy handoff items don't record their source models, but the
 * covered runs are still in the projection.
 */
function latestRunModelBefore(
  runs: ReadonlyArray<HandoffTimelineRun>,
  instanceId: ProviderInstanceId,
  beforeOrdinal: number | undefined,
): string | undefined {
  let latest: HandoffTimelineRun | undefined;
  for (const run of runs) {
    if (run.providerInstanceId !== instanceId) continue;
    if (beforeOrdinal !== undefined && run.ordinal >= beforeOrdinal) continue;
    if (latest === undefined || run.ordinal > latest.ordinal) latest = run;
  }
  return latest?.modelSelection.model;
}
