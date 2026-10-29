import { assert, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { resolveEffortOption, type ThreadTools, waitForRun } from "./thread.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

/** Answers each tool call with the next scripted response for that tool. */
const scriptedTools = (script: Record<string, Array<unknown>>) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call = ((tool: string, args: unknown) => {
    calls.push({ tool, args });
    const next = script[tool]?.shift();
    return next === undefined ? Effect.die(`unscripted ${tool} call`) : Effect.succeed(next);
  }) as ThreadTools["call"];
  return { tools: { call } satisfies ThreadTools, calls };
};

it.effect("--wait follows the sent run to its continuation's terminal status", () =>
  Effect.gen(function* () {
    const continuation = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId: continuation, status: "failed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 0 } }],
    });

    const outcome = yield* waitForRun(tools, threadId, runId);

    assert.deepStrictEqual(outcome, { type: "ended", runId: continuation, status: "failed" });
    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "t3_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000 },
      ],
    );
  }),
);

it.effect("--wait stops when the thread waits for an answer instead of polling forever", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "queued", timedOut: true },
        { threadId, runId, status: "queued", timedOut: true },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), { type: "needs_input" });
  }),
);

it.effect("--wait reports its run's result when a later run is the one waiting", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId, status: "completed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);

const capabilities = (models: ReadonlyArray<unknown>) => ({
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  providers: [
    {
      providerInstanceId: "claudeAgent",
      driverKind: "claudeAgent",
      displayName: null,
      models,
      canRunChildTask: true,
      canRunCrossProviderChildTask: true,
      constraints: [],
    },
  ],
  features: {
    appOwnedSubagents: true,
    asyncPolling: true,
    cancellation: true,
    batchThreadCreation: true,
    threadManagement: true,
    incrementalThreadRead: true,
    scheduledTasks: true,
    maxBatchThreads: 10,
  },
});

const opus = {
  id: "claude-opus-5-5",
  options: [
    { id: "fastMode", values: [false, true] },
    { id: "effort", values: ["low", "medium", "high"], default: "medium" },
  ],
};

it.effect("--effort sets the model's own reasoning option id", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({ orchestrator_capabilities: [capabilities([opus])] });

    const option = yield* resolveEffortOption(tools, {
      provider: "claudeAgent",
      model: "claude-opus-5-5",
      effort: "high",
    });

    assert.deepStrictEqual(option, { id: "effort", value: "high" });
  }),
);

it.effect("--effort rejects a level the model does not offer", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({ orchestrator_capabilities: [capabilities([opus])] });

    const error = yield* resolveEffortOption(tools, {
      provider: "claudeAgent",
      model: "claude-opus-5-5",
      effort: "xhigh",
    }).pipe(Effect.flip);

    assert.strictEqual(error.message, "--effort for claude-opus-5-5 is one of: low, medium, high.");
  }),
);
