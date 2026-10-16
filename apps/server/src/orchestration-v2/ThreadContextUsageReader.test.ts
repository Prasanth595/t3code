import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type ThreadContextUsage,
  type ThreadContextUsageError,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadContextUsageReader from "./ThreadContextUsageReader.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread-context");
const activeSessionId = ProviderSessionId.make("provider-session-active");
const earlierSessionId = ProviderSessionId.make("provider-session-earlier");
const providerInstanceId = ProviderInstanceId.make("claudeAgent");
const activeThread = {
  id: ProviderThreadId.make("provider-thread-active"),
  providerInstanceId,
  providerSessionId: activeSessionId,
} as OrchestrationV2ProviderThread;
// Listed last, so only an active-thread lookup picks the right one.
const earlierThread = {
  id: ProviderThreadId.make("provider-thread-earlier"),
  providerInstanceId,
  providerSessionId: earlierSessionId,
} as OrchestrationV2ProviderThread;

const usage: ThreadContextUsage = {
  model: "claude-sonnet-4-6",
  usedTokens: 41_235,
  maxTokens: 200_000,
  categories: [{ name: "Messages", tokens: 24_325, kind: "used" }],
  groups: [],
};

function makeLayer(input: {
  readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
  /** Running sessions, by provider session id. */
  readonly runtimes: Readonly<
    Record<string, Partial<ProviderAdapter.ProviderAdapterV2SessionRuntime>>
  >;
  /** Whether the provider declares it can break its context down. Defaults to true. */
  readonly reportsContextBreakdown?: boolean;
}) {
  return ThreadContextUsageReader.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { activeProviderThreadId: activeThread.id },
              providerThreads: input.providerThreads,
            } as never),
        }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          get: () =>
            Effect.succeed({
              getCapabilities: () =>
                Effect.succeed({
                  context: { reportsContextBreakdown: input.reportsContextBreakdown ?? true },
                }),
            } as never),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          // `get` would count the read as activity and keep an idle session open.
          get: () => Effect.die("reading context usage must not touch session activity"),
          peek: (providerSessionId) =>
            Effect.succeed(
              Option.fromUndefinedOr(
                input.runtimes[providerSessionId] as
                  | ProviderAdapter.ProviderAdapterV2SessionRuntime
                  | undefined,
              ),
            ),
        }),
      ),
    ),
  );
}

const readFailure = Effect.gen(function* () {
  const reader = yield* ThreadContextUsageReader.ThreadContextUsageReader;
  return yield* reader.read({ threadId }).pipe(Effect.flip);
});

const reason = (error: ThreadContextUsageError) => error.reason;

describe("ThreadContextUsageReader", () => {
  it.effect("reads the active provider thread's live session", () => {
    const asked: Array<OrchestrationV2ProviderThread> = [];
    return Effect.gen(function* () {
      const reader = yield* ThreadContextUsageReader.ThreadContextUsageReader;
      assert.deepEqual(yield* reader.read({ threadId }), usage);
      assert.deepEqual(asked, [activeThread]);
    }).pipe(
      Effect.provide(
        makeLayer({
          providerThreads: [activeThread, earlierThread],
          runtimes: {
            [activeSessionId]: {
              readContextUsage: ({ providerThread }) =>
                Effect.sync(() => {
                  asked.push(providerThread);
                  return usage;
                }),
            },
            [earlierSessionId]: { readContextUsage: () => Effect.die("wrong provider thread") },
          },
        }),
      ),
    );
  });

  it.effect("reads the provider thread the client asks for", () =>
    Effect.gen(function* () {
      const reader = yield* ThreadContextUsageReader.ThreadContextUsageReader;
      assert.deepEqual(yield* reader.read({ threadId, providerThreadId: earlierThread.id }), usage);
      const foreign = yield* reader
        .read({ threadId, providerThreadId: ProviderThreadId.make("provider-thread-foreign") })
        .pipe(Effect.flip);
      assert.equal(foreign.reason, "session-stopped");
    }).pipe(
      Effect.provide(
        makeLayer({
          providerThreads: [activeThread, earlierThread],
          runtimes: {
            [activeSessionId]: { readContextUsage: () => Effect.die("wrong provider thread") },
            [earlierSessionId]: { readContextUsage: () => Effect.succeed(usage) },
          },
        }),
      ),
    ),
  );

  it.effect("reports a session that is not running instead of starting one", () =>
    Effect.gen(function* () {
      assert.equal(reason(yield* readFailure), "session-stopped");
    }).pipe(Effect.provide(makeLayer({ providerThreads: [activeThread], runtimes: {} }))),
  );

  it.effect("reports a session whose native process has not started yet", () =>
    Effect.gen(function* () {
      assert.equal(reason(yield* readFailure), "session-stopped");
    }).pipe(
      Effect.provide(
        makeLayer({
          providerThreads: [activeThread],
          runtimes: { [activeSessionId]: { readContextUsage: () => Effect.succeed(null) } },
        }),
      ),
    ),
  );

  it.effect("reports a thread whose provider has never run", () =>
    Effect.gen(function* () {
      assert.equal(reason(yield* readFailure), "session-stopped");
    }).pipe(Effect.provide(makeLayer({ providerThreads: [], runtimes: {} }))),
  );

  it.effect("reports a provider without a breakdown even when its session is stopped", () =>
    Effect.gen(function* () {
      assert.equal(reason(yield* readFailure), "provider-unsupported");
    }).pipe(
      Effect.provide(
        makeLayer({
          providerThreads: [{ ...activeThread, providerSessionId: null }],
          runtimes: {},
          reportsContextBreakdown: false,
        }),
      ),
    ),
  );

  it.effect("reports providers that cannot measure their context", () =>
    Effect.gen(function* () {
      assert.equal(reason(yield* readFailure), "provider-unsupported");
    }).pipe(
      Effect.provide(
        makeLayer({ providerThreads: [activeThread], runtimes: { [activeSessionId]: {} } }),
      ),
    ),
  );

  it.effect("reports a failed provider request with its cause", () => {
    const cause = new ProviderAdapter.ProviderAdapterProtocolError({
      driver: ProviderDriverKind.make("claudeAgent"),
      detail: "Context usage request failed",
    });
    return Effect.gen(function* () {
      const error = yield* readFailure;
      assert.equal(error.reason, "request-failed");
      assert.strictEqual(error.cause, cause);
    }).pipe(
      Effect.provide(
        makeLayer({
          providerThreads: [activeThread],
          runtimes: { [activeSessionId]: { readContextUsage: () => Effect.fail(cause) } },
        }),
      ),
    );
  });
});
