import * as Layer from "effect/Layer";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

export type ProviderOrchestrationAdapterInfrastructure = IdAllocator.IdAllocatorV2;

/** Reuse the continuation worker's exact layer reference so memoization shares one queue. */
export const layer = Layer.mergeAll(IdAllocator.layer, ProviderContinuationRequests.layer);
