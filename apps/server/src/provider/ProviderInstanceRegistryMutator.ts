/**
 * Kept separate from the public `ProviderInstanceRegistry` service tag so
 * downstream consumers (drivers, reactors, `ProviderService`) can only read
 * from the registry.
 *
 * Closes the per-instance `Scope` of every removed or replaced entry (tearing
 * down adapter processes, refresh fibres, temp files) BEFORE creating the
 * replacement — `reconcile` guarantees "at most one live instance per id" at
 * all times.
 *
 * `reconcile` is idempotent: calling it with an unchanged config map is a
 * no-op (no scope churn, no pubsub emission).
 */
import type { ProviderInstanceConfigMap } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProviderInstanceRegistryMutatorShape {
  /**
   * The effect never fails: individual driver `create` failures are
   * captured as "unavailable" shadow snapshots inside the registry, the
   * same way boot-time failures are handled by
   * `makeProviderInstanceRegistry`. This keeps settings-watcher loops from
   * erroring out on a single bad entry.
   */
  readonly reconcile: (configMap: ProviderInstanceConfigMap) => Effect.Effect<void>;
}

export class ProviderInstanceRegistryMutator extends Context.Service<
  ProviderInstanceRegistryMutator,
  ProviderInstanceRegistryMutatorShape
>()("t3/provider/ProviderInstanceRegistryMutator") {}
