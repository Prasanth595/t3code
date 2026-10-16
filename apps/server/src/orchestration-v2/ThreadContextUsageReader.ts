import {
  ThreadContextUsageError,
  type ThreadContextUsage,
  type ThreadContextUsageInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/**
 * Reads what fills a thread's context window from its live provider session.
 * A stopped session is reported, never started, and the read does not count as
 * session activity: looking at the breakdown must not spend a turn or keep an
 * idle provider process alive.
 */
export class ThreadContextUsageReader extends Context.Service<
  ThreadContextUsageReader,
  {
    readonly read: (
      input: ThreadContextUsageInput,
    ) => Effect.Effect<ThreadContextUsage, ThreadContextUsageError>;
  }
>()("t3/orchestration-v2/ThreadContextUsageReader") {}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;

  const fail = (threadId: ThreadId, reason: ThreadContextUsageError["reason"], cause?: unknown) =>
    new ThreadContextUsageError({ threadId, reason, ...(cause === undefined ? {} : { cause }) });

  const read = Effect.fn("ThreadContextUsageReader.read")(function* (
    input: ThreadContextUsageInput,
  ) {
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, ["providerThreads"])
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
    const providerThreadId = input.providerThreadId ?? records.thread.activeProviderThreadId;
    const providerThread =
      input.providerThreadId === undefined
        ? (records.providerThreads.find((candidate) => candidate.id === providerThreadId) ??
          records.providerThreads.at(-1))
        : records.providerThreads.find((candidate) => candidate.id === providerThreadId);
    if (providerThread === undefined) return yield* fail(input.threadId, "session-stopped");
    // Asked before the session, so a provider that can never break its context
    // down says so even while nothing is running.
    const capabilities = yield* adapters.get(providerThread.providerInstanceId).pipe(
      Effect.flatMap((adapter) => adapter.getCapabilities()),
      Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)),
    );
    if (capabilities.context.reportsContextBreakdown !== true) {
      return yield* fail(input.threadId, "provider-unsupported");
    }
    if (providerThread.providerSessionId === null) {
      return yield* fail(input.threadId, "session-stopped");
    }
    const runtime = Option.getOrUndefined(
      yield* providerSessions.peek(providerThread.providerSessionId),
    );
    if (runtime === undefined) return yield* fail(input.threadId, "session-stopped");
    if (runtime.readContextUsage === undefined) {
      return yield* fail(input.threadId, "provider-unsupported");
    }
    const usage = yield* runtime
      .readContextUsage({ providerThread })
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
    if (usage === null) return yield* fail(input.threadId, "session-stopped");
    return usage;
  });

  return ThreadContextUsageReader.of({ read });
});

export const layer = Layer.effect(ThreadContextUsageReader, make);
