import type {
  OrchestrationV2HistoricalMessage,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

export const latestNativeCompactionRunOrdinal = (input: {
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "id" | "ordinal" | "providerThreadId" | "userMessageId">
  >;
  readonly turnItems: ReadonlyArray<
    Pick<OrchestrationV2TurnItem, "type" | "runId" | "providerThreadId">
  >;
  readonly providerThreadId: ProviderThreadId;
  readonly compactionMessageIds: ReadonlySet<OrchestrationV2Run["userMessageId"]>;
}) => {
  const providerCompactionRunIds = new Set(
    input.turnItems
      .filter(
        (item) => item.type === "compaction" && item.providerThreadId === input.providerThreadId,
      )
      .flatMap((item) => (item.runId === null ? [] : [item.runId])),
  );

  return input.runs.reduce<number | undefined>(
    (latest, run) =>
      run.providerThreadId === input.providerThreadId &&
      (input.compactionMessageIds.has(run.userMessageId) || providerCompactionRunIds.has(run.id))
        ? Math.max(latest ?? run.ordinal, run.ordinal)
        : latest,
    undefined,
  );
};

type NativeHistoryItem = {
  readonly threadId: OrchestrationV2HistoricalMessage["threadId"];
  readonly providerThreadId?: OrchestrationV2TurnItem["providerThreadId"];
  readonly runId?: OrchestrationV2TurnItem["runId"];
  readonly type?: OrchestrationV2TurnItem["type"];
  readonly kind?: OrchestrationV2HistoricalMessage["kind"];
  readonly nativeItemRef?: OrchestrationV2TurnItem["nativeItemRef"] | undefined;
};

export const itemIsInNativeThread = (input: {
  readonly item: NativeHistoryItem;
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly acceptedRunIds: ReadonlySet<RunId>;
  readonly runOrdinals: ReadonlyMap<RunId, number>;
  readonly latestCompactionRunOrdinal: number | undefined;
}) => {
  const { item } = input;
  if (
    item.type === "run_interrupt_result" ||
    item.kind === "run_interrupt_result" ||
    ((item.type === "command_execution" ||
      item.kind === "command_execution" ||
      item.type === "error" ||
      item.kind === "error") &&
      item.nativeItemRef?.nativeId == null) ||
    item.threadId !== input.threadId ||
    item.providerThreadId !== input.providerThreadId ||
    item.runId == null ||
    !input.acceptedRunIds.has(item.runId)
  )
    return false;

  const runOrdinal = input.runOrdinals.get(item.runId);
  return (
    runOrdinal !== undefined &&
    (input.latestCompactionRunOrdinal === undefined ||
      runOrdinal > input.latestCompactionRunOrdinal)
  );
};
