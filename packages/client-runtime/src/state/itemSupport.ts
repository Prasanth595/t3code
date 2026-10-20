import {
  PROVIDER_DISPLAY_NAMES,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ProjectedTurnItem,
  type ServerProvider,
  type TurnItemId,
} from "@t3tools/contracts";

type Projection = OrchestrationV2ThreadProjection;

export interface V2ItemSupport {
  readonly item: Projection["turnItems"][number] | null;
  readonly run: Projection["runs"][number] | null;
  readonly attempts: ReadonlyArray<Projection["attempts"][number]>;
  readonly node: Projection["nodes"][number] | null;
  readonly providerSession: Projection["providerSessions"][number] | null;
  readonly providerThread: Projection["providerThreads"][number] | null;
  readonly providerTurn: Projection["providerTurns"][number] | null;
  readonly runtimeRequest: Projection["runtimeRequests"][number] | null;
  readonly checkpoint: Projection["checkpoints"][number] | null;
  readonly subagent: Projection["subagents"][number] | null;
  readonly contextHandoff: Projection["contextHandoffs"][number] | null;
  readonly contextTransfer: Projection["contextTransfers"][number] | null;
}

export const EMPTY_V2_ITEM_SUPPORT: V2ItemSupport = Object.freeze({
  item: null,
  run: null,
  attempts: Object.freeze([]),
  node: null,
  providerSession: null,
  providerThread: null,
  providerTurn: null,
  runtimeRequest: null,
  checkpoint: null,
  subagent: null,
  contextHandoff: null,
  contextTransfer: null,
});

export function resolveV2ItemSupport(projection: Projection, itemId: TurnItemId): V2ItemSupport {
  const item =
    projection.turnItems.find((candidate) => candidate.id === itemId) ??
    projection.visibleTurnItems.find((candidate) => candidate.sourceItemId === itemId)?.item ??
    null;
  if (item === null) return EMPTY_V2_ITEM_SUPPORT;

  const run =
    item.runId === null
      ? null
      : (projection.runs.find((candidate) => candidate.id === item.runId) ?? null);
  const attempts =
    item.runId === null
      ? EMPTY_V2_ITEM_SUPPORT.attempts
      : projection.attempts.filter((candidate) => candidate.runId === item.runId);
  const node =
    item.nodeId === null
      ? null
      : (projection.nodes.find((candidate) => candidate.id === item.nodeId) ?? null);
  const providerThread =
    item.providerThreadId === null || item.providerThreadId === undefined
      ? null
      : (projection.providerThreads.find((candidate) => candidate.id === item.providerThreadId) ??
        null);
  const providerSession =
    providerThread?.providerSessionId == null
      ? null
      : (projection.providerSessions.find(
          (candidate) => candidate.id === providerThread.providerSessionId,
        ) ?? null);
  const providerTurn =
    item.providerTurnId === null
      ? null
      : (projection.providerTurns.find((candidate) => candidate.id === item.providerTurnId) ??
        null);
  const requestId =
    item.type === "approval_request" || item.type === "user_input_request"
      ? item.requestId
      : node?.runtimeRequestId;
  const runtimeRequest =
    requestId == null
      ? null
      : (projection.runtimeRequests.find((candidate) => candidate.id === requestId) ?? null);
  const checkpoint =
    item.type === "checkpoint"
      ? (projection.checkpoints.find((candidate) => candidate.id === item.checkpointId) ?? null)
      : null;
  const subagent =
    item.type === "subagent"
      ? (projection.subagents.find((candidate) => candidate.id === item.subagentId) ?? null)
      : null;
  const contextHandoff =
    item.type === "handoff"
      ? (projection.contextHandoffs.find((candidate) => candidate.id === item.contextHandoffId) ??
        null)
      : null;
  const contextTransfer =
    contextHandoff?.transferId == null
      ? null
      : (projection.contextTransfers.find(
          (candidate) => candidate.id === contextHandoff.transferId,
        ) ?? null);

  return {
    item,
    run,
    attempts,
    node,
    providerSession,
    providerThread,
    providerTurn,
    runtimeRequest,
    checkpoint,
    subagent,
    contextHandoff,
    contextTransfer,
  };
}

export function resolveV2ItemProviderOrigin(
  support: V2ItemSupport,
  source: Pick<OrchestrationV2ProjectedTurnItem, "sourceThreadId" | "sourceItemId">,
) {
  const { item, providerThread, providerTurn, attempts, run } = support;
  if (item === null || item.id !== source.sourceItemId || item.threadId !== source.sourceThreadId)
    return null;
  if (item.providerTurnId !== null && providerTurn === null) return null;
  if (
    providerTurn !== null &&
    (providerTurn.id !== item.providerTurnId ||
      providerTurn.providerThreadId !== item.providerThreadId)
  )
    return null;
  if (providerThread !== null) {
    if (providerThread.id !== item.providerThreadId || providerThread.appThreadId !== item.threadId)
      return null;
    const attemptId = providerTurn?.runAttemptId;
    if (attemptId != null) {
      const attempt = attempts.find((candidate) => candidate.id === attemptId);
      if (
        attempt === undefined ||
        attempt.runId !== item.runId ||
        attempt.providerThreadId !== providerThread.id ||
        attempt.providerInstanceId !== providerThread.providerInstanceId ||
        (attempt.providerTurnId !== null && attempt.providerTurnId !== item.providerTurnId)
      )
        return null;
      return { providerInstanceId: attempt.providerInstanceId, driver: providerThread.driver };
    }
    return { providerInstanceId: providerThread.providerInstanceId, driver: providerThread.driver };
  }
  if (item.providerThreadId != null || item.providerTurnId !== null) return null;
  if (
    run !== null &&
    run.id === item.runId &&
    run.threadId === item.threadId &&
    run.rootNodeId !== null &&
    run.rootNodeId === item.nodeId
  )
    return { providerInstanceId: run.providerInstanceId, driver: null };
  return null;
}

// The instance ID is only a lookup key: it is opaque and must never become label text.
export function formatV2ProviderOriginLabel(
  origin: ReturnType<typeof resolveV2ItemProviderOrigin>,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver" | "displayName">> | null,
): string {
  if (origin === null) return "Provider origin unavailable";
  const provider = providers?.find(
    (candidate) => candidate.instanceId === origin.providerInstanceId,
  );
  const driver = origin.driver ?? provider?.driver;
  if (driver === undefined) return "Provider origin unavailable";
  const driverLabel = PROVIDER_DISPLAY_NAMES[driver] ?? driver;
  const instanceLabel = provider?.driver === driver ? provider.displayName?.trim() : undefined;
  return instanceLabel
    ? `${driverLabel} · Instance: ${instanceLabel}`
    : `${driverLabel} · Instance label unavailable`;
}

function sameEntities<A>(left: ReadonlyArray<A>, right: ReadonlyArray<A>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function v2ItemSupportEqual(left: V2ItemSupport, right: V2ItemSupport): boolean {
  return (
    left.item === right.item &&
    left.run === right.run &&
    sameEntities(left.attempts, right.attempts) &&
    left.node === right.node &&
    left.providerSession === right.providerSession &&
    left.providerThread === right.providerThread &&
    left.providerTurn === right.providerTurn &&
    left.runtimeRequest === right.runtimeRequest &&
    left.checkpoint === right.checkpoint &&
    left.subagent === right.subagent &&
    left.contextHandoff === right.contextHandoff &&
    left.contextTransfer === right.contextTransfer
  );
}
