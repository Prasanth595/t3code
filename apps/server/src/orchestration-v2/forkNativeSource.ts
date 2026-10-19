import type {
  OrchestrationV2ContextSourcePoint,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";

class ForkSourceError extends Schema.TaggedError<ForkSourceError>()("ForkSourceError", {
  reason: Schema.Literals(["session", "cursor"]),
}) {
  override get message() {
    return this.reason === "session"
      ? "Cannot fork this run: its native provider session has not been resolved. No thread was created."
      : "Cannot fork this Claude run: no native message cursor was recorded for this point. Choose a run with a recorded cursor. No thread was created.";
  }
}

export const resolveForkSourcePoint = Effect.fn("fork.resolveSourcePoint")(function* (
  projection: Pick<OrchestrationV2ThreadProjection, "providerThreads" | "turnItems"> & {
    readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "providerInstanceId">;
  },
  run: Pick<OrchestrationV2Run, "id" | "providerThreadId" | "providerInstanceId" | "status">,
  point: OrchestrationV2ContextSourcePoint,
) {
  if (
    (run.status !== "completed" && run.status !== "waiting") ||
    projection.thread.providerInstanceId !== run.providerInstanceId
  )
    return point;
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const adapter = yield* registry.get(run.providerInstanceId);
  const capabilities = yield* adapter.getCapabilities();
  if (
    !capabilities.threads.canForkThread ||
    !capabilities.threads.canForkFromTurn ||
    capabilities.identity.nativeThreadIds !== "strong"
  )
    return point;
  const source = projection.providerThreads.find((thread) => thread.id === run.providerThreadId);
  if (
    !source?.nativeThreadRef?.nativeId ||
    source.nativeThreadRef.nativeId.startsWith("pending:") ||
    source.nativeThreadRef.strength !== "strong"
  ) {
    return yield* new ForkSourceError({ reason: "session" });
  }
  if (source.driver !== "claudeAgent") return point;
  const cursor = point.providerTurnRef?.nativeId;
  if (cursor && !cursor.startsWith("turn:")) return point;
  // Older /compact runs kept the boundary UUID on the item, not the turn.
  const boundary = projection.turnItems.findLast(
    (item) =>
      item.runId === run.id && item.type === "compaction" && item.providerThreadId === source.id,
  );
  if (boundary?.nativeItemRef?.nativeId)
    return { ...point, providerTurnRef: boundary.nativeItemRef };
  return yield* new ForkSourceError({ reason: "cursor" });
});

export function forkSourceTurns(
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  turn: OrchestrationV2ProviderTurn | undefined,
  point: OrchestrationV2ContextSourcePoint,
) {
  return turns.map((candidate) =>
    candidate.id === turn?.id && point.providerTurnRef !== undefined
      ? { ...candidate, nativeTurnRef: point.providerTurnRef }
      : candidate,
  );
}
