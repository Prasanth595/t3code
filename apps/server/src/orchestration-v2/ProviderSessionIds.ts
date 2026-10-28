import type { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

/** Pooled providers share one session per instance; every other provider gets one per thread. */
export const newProviderSessionId = (input: {
  readonly adapter: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
}) =>
  input.adapter.getCapabilities().pipe(
    Effect.flatMap((capabilities) =>
      capabilities.sessions.supportsMultipleProviderThreadsPerSession
        ? Effect.succeed(
            input.idAllocator.derive.providerSession({
              providerInstanceId: input.providerInstanceId,
            }),
          )
        : input.idAllocator.allocate.providerSession({
            providerInstanceId: input.providerInstanceId,
            threadId: input.threadId,
          }),
    ),
  );

/**
 * A thread's stored session id, unless it names its instance's shared session.
 * newProviderSessionId re-derives that id for pooled providers, so a thread leaves
 * the shared session once its provider runs one session per thread.
 */
export const reusableProviderSessionId = (
  idAllocator: Pick<IdAllocator.IdAllocatorV2["Service"], "derive">,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: ProviderSessionId | null | undefined,
): ProviderSessionId | undefined =>
  providerSessionId == null ||
  providerSessionId === idAllocator.derive.providerSession({ providerInstanceId })
    ? undefined
    : providerSessionId;
