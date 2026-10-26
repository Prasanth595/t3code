import { layerNativeSessionStore } from "../orchestration-v2/eventInfrastructure.ts";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CursorAgentSdk from "@t3tools/provider-cursor/server/CursorAgentSdk";
import * as CursorSdk from "@t3tools/provider-cursor/server/CursorSdk";
import * as CursorKeychain from "@t3tools/provider-cursor/server/CursorKeychain";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ClaudeSessionRuntime from "../orchestration-v2/ClaudeSessionRuntime.ts";
import * as ClaudeSessionHost from "../orchestration-v2/ClaudeSessionHost.ts";
import * as ClaudeSessionFence from "../orchestration-v2/ClaudeSessionFence.ts";
import * as ClaudeSessionJournal from "../orchestration-v2/ClaudeSessionJournal.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

export const layerClaudeIdentity = ClaudeSessionHost.layerIdentity.pipe(
  Layer.provide(ProjectStore.layer),
);
const layerClaudeValidation = Layer.effect(
  ClaudeSessionRuntime.ClaudeSessionRuntimeValidation,
  Effect.gen(function* () {
    const identity = yield* ClaudeSessionHost.ClaudeSessionIdentity;
    return ClaudeSessionRuntime.ClaudeSessionRuntimeValidation.of({
      validatePlan: identity.validatePlan,
    });
  }),
).pipe(Layer.provide(layerClaudeIdentity));
const layerClaudeFence = ClaudeSessionFence.layer.pipe(Layer.provide(ClaudeSessionJournal.layer));
export const layerClaudeRuntime = ClaudeSessionRuntime.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ClaudeAdapterV2.layerQueryRunner,
      layerClaudeFence,
      layerClaudeValidation,
      IdAllocator.layer,
      ClaudeSessionRuntime.layerProcessProbe,
    ),
  ),
);
const layerClaudeRunner = Layer.effect(
  ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
  Effect.gen(function* () {
    return (yield* ClaudeSessionRuntime.ClaudeSessionRuntime).runner;
  }),
).pipe(Layer.provide(layerClaudeRuntime));

export type ProviderOrchestrationAdapterInfrastructure =
  | ClaudeAdapterV2.ClaudeAgentSdkQueryRunner
  | CodexAdapterV2.CodexAppServerClientFactory
  | CursorAgentSdk.CursorAgentSdkRunner
  | CursorSdk.CursorSdk
  | CursorKeychain.CursorKeychain
  | IdAllocator.IdAllocatorV2;

/** Reuse the continuation worker's exact layer reference so memoization shares one queue. */
export const layer = Layer.mergeAll(
  layerClaudeRunner,
  CodexAdapterV2.layerAppServerClientFactory.pipe(Layer.provide(layerNativeSessionStore)),
  CursorAgentSdk.layer.pipe(Layer.provideMerge(CursorSdk.layer)),
  CursorKeychain.layer,
  IdAllocator.layer,
  ProviderContinuationRequests.layer,
);
