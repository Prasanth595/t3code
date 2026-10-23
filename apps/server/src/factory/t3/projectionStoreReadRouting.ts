import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SqlClient } from "effect/sql/SqlClient";

import * as Upstream from "../../orchestration-v2/ProjectionStore.ts";

/**
 * The projection store with its two whole-table reads moved off the event loop.
 *
 * `getShellSnapshot` (ThreadLaunchService's prepare loop) and `getThreadsWithPullRequests` (both
 * pull request reactor sweeps) scan every thread. Upstream runs them on the writer connection,
 * which blocks the main thread; inside `readOnly` they run on the reader worker, and only the
 * decode stays on the loop. `readOnly` wraps the whole transaction and falls back to the writer
 * inside an open write transaction, so it is safe for every caller.
 *
 * `server.ts` imports the store through this module, so every `ProjectionStoreV2.layer` it
 * provides is this one. Everything else upstream exports passes through untouched.
 */
export * from "../../orchestration-v2/ProjectionStore.ts";

/** One module-level const, so the layer is memoized by reference like upstream's. */
export const layer: Layer.Layer<Upstream.ProjectionStoreV2, never, SqlClient> = Layer.effect(
  Upstream.ProjectionStoreV2,
  Effect.gen(function* () {
    const store = yield* Upstream.ProjectionStoreV2;
    return Upstream.ProjectionStoreV2.of({
      ...store,
      getShellSnapshot: (options) => NodeSqliteClient.readOnly(store.getShellSnapshot(options)),
      getThreadsWithPullRequests: (threadId) =>
        NodeSqliteClient.readOnly(store.getThreadsWithPullRequests(threadId)),
    });
  }),
).pipe(Layer.provide(Upstream.layer));
