import type { OrchestrationV2ThreadDetailSnapshot } from "@t3tools/contracts";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

export const THREAD_CACHE_MAX_BYTES = 1_048_576;
const THREAD_CACHE_MAX_ROWS = 75;
const encoder = new TextEncoder();
const encodedBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

/** Keep the persisted recent window independent of the expanded in-memory timeline. */
export function boundThreadSnapshotForCache(snapshot: OrchestrationV2ThreadDetailSnapshot) {
  // Only server-supplied paging metadata proves omitted rows can be recovered.
  // A null cursor still identifies a complete window from a paging server.
  if (snapshot.historyCursor === undefined) return snapshot;
  const projection = snapshot.projection;
  const rows = projection.visibleTurnItems;
  const latestRun = projection.runs.reduce<(typeof projection.runs)[number] | null>(
    (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );
  const activeRuns = new Set(
    projection.runs
      .filter((run) =>
        ["queued", "waiting", "preparing", "starting", "running"].includes(run.status),
      )
      .map((run) => run.id),
  );
  const requiredRuns = new Set(activeRuns);
  if (latestRun !== null) requiredRuns.add(latestRun.id);
  const pendingRequests = new Set(
    projection.runtimeRequests
      .filter((request) => request.status === "pending")
      .map((request) => request.id),
  );
  const dependencies = projection.turnItems.filter(
    (item) =>
      item.type === "run_interrupt_request" ||
      (item.runId !== null && activeRuns.has(item.runId)) ||
      ("requestId" in item && pendingRequests.has(item.requestId)),
  );
  const dependencyIds = new Set(dependencies.map((item) => item.id));
  const messageIds = new Set(
    dependencies.flatMap((item) => ("messageId" in item ? [item.messageId] : [])),
  );
  for (const run of projection.runs) {
    if (requiredRuns.has(run.id)) messageIds.add(run.userMessageId);
  }
  const requiredMessages = projection.messages.filter(
    (message) =>
      messageIds.has(message.id) ||
      (message.runId !== null && requiredRuns.has(message.runId)) ||
      message.delegatedCompletion !== undefined,
  );
  for (const message of requiredMessages) messageIds.add(message.id);
  const messageById = new Map(projection.messages.map((message) => [message.id, message]));
  const controlBytes = encodedBytes({
    ...projection,
    messages: requiredMessages,
    turnItems: dependencies,
    visibleTurnItems: [],
  });
  let bytes = controlBytes + 1_024;
  let start = rows.length;
  while (start > 0 && rows.length - start < THREAD_CACHE_MAX_ROWS) {
    const row = rows[start - 1]!;
    const local = row.visibility === "local" || row.sourceThreadId === projection.thread.id;
    const messageId = local && "messageId" in row.item ? row.item.messageId : undefined;
    const message =
      messageId !== undefined && !messageIds.has(messageId)
        ? messageById.get(messageId)
        : undefined;
    const cost =
      encodedBytes(row) +
      (local && !dependencyIds.has(row.item.id) ? encodedBytes(row.item) : 0) +
      (message === undefined ? 0 : encodedBytes(message));
    if (start < rows.length && bytes + cost > THREAD_CACHE_MAX_BYTES) break;
    bytes += cost;
    if (messageId !== undefined) messageIds.add(messageId);
    start--;
  }
  const visibleTurnItems = rows
    .slice(start)
    .map((row, position) => (row.position === position ? row : { ...row, position }));
  const localIds = new Set(
    visibleTurnItems
      .filter((row) => row.visibility === "local" || row.sourceThreadId === projection.thread.id)
      .map((row) => row.sourceItemId),
  );
  const turnItems = projection.turnItems.filter(
    (item) => localIds.has(item.id) || dependencyIds.has(item.id),
  );
  const messages = projection.messages.filter((message) => messageIds.has(message.id));
  if (
    start === 0 &&
    turnItems.length === projection.turnItems.length &&
    messages.length === projection.messages.length
  ) {
    return snapshot;
  }

  // Server cursors anchor by item identity. Preserve the absolute position from
  // an existing bounded cursor for the fallback when that anchor is later deleted.
  let positionOffset = 0;
  if (snapshot.historyCursor && snapshot.historyCursor.length <= 4_096) {
    const decoded = Base64Url.decodeString(snapshot.historyCursor);
    if (Result.isSuccess(decoded)) {
      try {
        const cursor: unknown = JSON.parse(decoded.success);
        if (
          cursor !== null &&
          typeof cursor === "object" &&
          "p" in cursor &&
          typeof cursor.p === "number" &&
          Number.isSafeInteger(cursor.p) &&
          cursor.p >= 0 &&
          "st" in cursor &&
          "si" in cursor
        ) {
          const index = rows.findIndex(
            (row) => row.sourceThreadId === cursor.st && row.sourceItemId === cursor.si,
          );
          if (index >= 0) positionOffset = Math.max(0, cursor.p - index);
        }
      } catch {
        // A malformed cache cursor does not prevent a fresh identity anchor.
      }
    }
  }
  const oldest = rows[start];
  const historyCursor =
    start > 0 && oldest
      ? Base64Url.encode(
          JSON.stringify({
            v: 1,
            seq: snapshot.snapshotSequence,
            st: oldest.sourceThreadId,
            si: oldest.sourceItemId,
            p: positionOffset + start,
          }),
        )
      : (snapshot.historyCursor ?? null);
  const latestLocalTurnOrdinal = projection.turnItems.reduce<number | null>(
    (latest, item) => (latest === null ? item.ordinal : Math.max(latest, item.ordinal)),
    snapshot.latestLocalTurnOrdinal ?? null,
  );
  return {
    ...snapshot,
    projection: { ...projection, messages, turnItems, visibleTurnItems },
    historyCursor,
    hasMoreHistory: start > 0 || snapshot.hasMoreHistory === true,
    latestLocalTurnOrdinal,
  };
}
