import type { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

export class TemporaryThreadLifecycleState extends Context.Service<
  TemporaryThreadLifecycleState,
  {
    readonly discarding: Set<ThreadId>;
    readonly commands: KeyedLock.KeyedLock<ThreadId>;
    readonly preparations: Map<ThreadId, Set<Fiber.Fiber<void>>>;
    readonly pendingNativeCleanup: Map<ThreadId, Map<string, ProviderSessionId>>;
  }
>()("t3/orchestration-v2/TemporaryThreadLifecycleState") {}

export const layer = Layer.effect(
  TemporaryThreadLifecycleState,
  Effect.gen(function* () {
    return {
      discarding: new Set<ThreadId>(),
      commands: yield* KeyedLock.make<ThreadId>(),
      preparations: new Map<ThreadId, Set<Fiber.Fiber<void>>>(),
      pendingNativeCleanup: new Map<ThreadId, Map<string, ProviderSessionId>>(),
    };
  }),
);
