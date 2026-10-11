import type { ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProjectionStore from "./ProjectionStore.ts";

/** Shared by thread commands and project deletion so both plan against current thread state. */
export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedLock.KeyedLock<ThreadId>
>()("t3/orchestration-v2/ThreadCommandExecutor") {}

export const layer = Layer.effect(ThreadCommandExecutor, KeyedLock.make<ThreadId>());

export const withHierarchyLock = <A, E, R>(
  executor: ThreadCommandExecutor["Service"],
  projections: Pick<
    ProjectionStore.ProjectionStoreV2["Service"],
    "getThread" | "getSwarmForMember"
  >,
  threadIds: ReadonlyArray<ThreadId>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const depths = new Map<ThreadId, number>();
    let grouped = false;
    for (const endpoint of threadIds) {
      const chain: Array<ThreadId> = [];
      let current: ThreadId | null = endpoint;
      while (current !== null && !chain.includes(current)) {
        chain.push(current);
        if ((yield* projections.getSwarmForMember(current)) !== undefined) grouped = true;
        const thread: Effect.Success<ReturnType<typeof projections.getThread>> | undefined =
          yield* projections.getThread(current).pipe(
            Effect.catchTags({
              ProjectionStoreThreadNotFoundError: () => Effect.succeed(undefined),
            }),
          );
        current =
          thread?.lineage.relationshipToParent === "subagent"
            ? thread.lineage.parentThreadId
            : null;
      }
      chain.toReversed().forEach((id, depth) => depths.set(id, depth));
    }
    if (!grouped)
      return yield* [...new Set(threadIds)].reduceRight(
        (next, id) => executor.withLock(id, next),
        effect,
      );
    const ordered = [...depths]
      .toSorted(([left, a], [right, b]) => a - b || left.localeCompare(right))
      .map(([id]) => id);
    return yield* ordered.reduceRight((next, id) => executor.withLock(id, next), effect);
  });
