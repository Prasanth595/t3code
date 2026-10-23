import * as Layer from "effect/Layer";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

import * as Upstream from "../../orchestration-v2/ProjectionStore.ts";

/**
 * The projection store with its two heavy whole-table reads moved off the event loop.
 * `server.ts` imports the store through this module, so every `ProjectionStoreV2.layer` it
 * provides is this one. Everything else upstream exports passes through untouched.
 */
export * from "../../orchestration-v2/ProjectionStore.ts";

export const layer: Layer.Layer<Upstream.ProjectionStoreV2, never, SqlClient> = Upstream.layer;
