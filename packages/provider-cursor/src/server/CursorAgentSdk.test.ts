import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";

const cursorSdkMock = vi.hoisted(() => {
  const closeExecutionOrder: Array<string> = [];
  const runOperations: Array<string> = [];
  let agentCloseFailure: unknown;
  let staleRunActive = false;
  const runWait = vi.fn(async () => ({
    id: "run-cursor-agent-sdk-test",
    requestId: "request-cursor-agent-sdk-test",
    status: "finished",
    result: "ok",
    model: { id: "default" },
    durationMs: 1,
  }));
  let rejectRunWait: ((cause: unknown) => void) | undefined;
  const runCancel = vi.fn(async () => {});
  let onDelta: ((input: { readonly update: unknown }) => Promise<void>) | undefined;
  const agentClose = vi.fn(() => {
    closeExecutionOrder.push("sdk:agent.close");
    if (agentCloseFailure !== undefined) {
      throw agentCloseFailure;
    }
  });
  const send = vi.fn(
    async (
      _message: unknown,
      options: { readonly onDelta?: (input: { readonly update: unknown }) => Promise<void> },
    ) => {
      runOperations.push("run.start");
      onDelta = options.onDelta;
      if (staleRunActive) {
        throw new Error("Agent agent-cursor-agent-sdk-test already has active run");
      }
      await options.onDelta?.({
        update: {
          type: "assistant-message-chunk",
          text: "hello",
        },
      });
      return {
        id: "run-cursor-agent-sdk-test",
        agentId: "agent-cursor-agent-sdk-test",
        wait: runWait,
        cancel: runCancel,
      };
    },
  );
  const create = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const resume = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const listRuns = vi.fn(async () => {
    runOperations.push("agent.listRuns");
    return {
      items: staleRunActive ? [{ id: "run-stale", status: "running" }] : [],
    };
  });
  const cancelRun = vi.fn(async () => {
    runOperations.push("agent.cancelRun");
    staleRunActive = false;
  });

  return {
    agentClose,
    cancelRun,
    closeExecutionOrder,
    create,
    listRuns,
    resume,
    runOperations,
    runCancel,
    runWait,
    send,
    deliverDelta: async (update: unknown) => onDelta?.({ update }),
    setRunWaitPending: () => {
      runWait.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectRunWait = reject;
          }),
      );
    },
    rejectRunWait: (cause: unknown) => rejectRunWait?.(cause),
    setAgentCloseFailure: (failure: unknown) => {
      agentCloseFailure = failure;
    },
    setStaleRunActive: (active: boolean) => {
      staleRunActive = active;
    },
  };
});

vi.mock("./sdk.ts", () => ({
  Agent: {
    create: cursorSdkMock.create,
    resume: cursorSdkMock.resume,
    listRuns: cursorSdkMock.listRuns,
    cancelRun: cursorSdkMock.cancelRun,
    messages: {
      list: vi.fn(async () => []),
    },
  },
  createAgentPlatform: vi.fn(),
  SqliteLocalAgentStore: { open: vi.fn() },
}));

const layerTest = CursorAgentSdk.layer.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
      native: {
        filePath: "cursor-agent-sdk-test.log",
        write: (event: unknown) =>
          Effect.sync(() => {
            if (
              typeof event === "object" &&
              event !== null &&
              Reflect.get(Reflect.get(event, "event"), "payload")?.type === "agent.close"
            ) {
              cursorSdkMock.closeExecutionOrder.push("protocol:agent.close");
            }
          }),
        close: () => Effect.void,
      },
      canonical: undefined,
    }),
  ),
  Layer.provide(CursorSdk.layer),
  Layer.provide(NodeServices.layer),
);

describe("CursorAgentSdkRunner", () => {
  it.effect("keeps dispatching after a callback failure and reports its method", () =>
    Effect.gen(function* () {
      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "create",
        options: { model: { id: "default" }, mode: "agent", local: { cwd: process.cwd() } },
        threadId: ThreadId.make("thread-cursor-agent-sdk-callback-failure-test"),
        providerSessionId: ProviderSessionId.make(
          "provider-session-cursor-agent-sdk-callback-failure-test",
        ),
      });
      const received: Array<string> = [];
      const run = yield* session.send({
        message: "continue",
        onDelta: (update) => {
          if (update.type === "text-delta" && update.text === "bad") {
            return Effect.die(new Error("local callback failed"));
          }
          if (update.type === "text-delta") received.push(update.text);
          return Effect.void;
        },
      });

      yield* Effect.promise(() => cursorSdkMock.deliverDelta({ type: "text-delta", text: "bad" }));
      yield* Effect.promise(() =>
        cursorSdkMock.deliverDelta({ type: "text-delta", text: "after failure" }),
      );
      const error = yield* run.wait.pipe(Effect.flip);

      assert.deepEqual(received, ["after failure"]);
      assert.equal(error.method, "run.onDelta");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("waits for an in-flight callback before classifying a run.wait failure", () =>
    Effect.gen(function* () {
      cursorSdkMock.setRunWaitPending();
      cursorSdkMock.runCancel.mockClear();
      let startCallback!: () => void;
      const callbackStarted = new Promise<void>((resolve) => {
        startCallback = resolve;
      });
      let failCallback!: () => void;
      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "create",
        options: { model: { id: "default" }, mode: "agent", local: { cwd: process.cwd() } },
        threadId: ThreadId.make("thread-cursor-agent-sdk-wait-race-test"),
        providerSessionId: ProviderSessionId.make(
          "provider-session-cursor-agent-sdk-wait-race-test",
        ),
      });
      const run = yield* session.send({
        message: "continue",
        onDelta: (update) => {
          if (update.type !== "text-delta" || update.text !== "pending") return Effect.void;
          return Effect.promise(
            () =>
              new Promise<void>((_resolve, reject) => {
                failCallback = () => reject(new Error("local callback failed"));
                startCallback();
              }),
          );
        },
      });

      const wait = yield* run.wait.pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      const delivery = cursorSdkMock.deliverDelta({ type: "text-delta", text: "pending" });
      yield* Effect.promise(() => callbackStarted);
      yield* Effect.sync(() => cursorSdkMock.rejectRunWait(new Error("SDK wait failed")));
      yield* Effect.sync(() => failCallback());
      yield* Effect.promise(() => delivery);

      const error = yield* Fiber.join(wait);
      assert.equal(error.method, "run.onDelta");
      assert.equal(cursorSdkMock.runCancel.mock.calls.length, 0);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("retries a resumed send after cancelling its abandoned local run", () =>
    Effect.gen(function* () {
      cursorSdkMock.runOperations.length = 0;
      cursorSdkMock.listRuns.mockClear();
      cursorSdkMock.cancelRun.mockClear();
      cursorSdkMock.setStaleRunActive(true);

      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "resume",
        agentId: "agent-cursor-agent-sdk-test",
        options: { model: { id: "default" }, mode: "agent", local: { cwd: process.cwd() } },
        threadId: ThreadId.make("thread-cursor-agent-sdk-stale-run-test"),
        providerSessionId: ProviderSessionId.make(
          "provider-session-cursor-agent-sdk-stale-run-test",
        ),
      });
      assert.deepStrictEqual(cursorSdkMock.runOperations, []);
      const run = yield* session.send({ message: "continue" });
      yield* run.wait;

      assert.deepStrictEqual(cursorSdkMock.runOperations, [
        "run.start",
        "agent.listRuns",
        "agent.cancelRun",
        "run.start",
      ]);
      assert.deepStrictEqual(cursorSdkMock.listRuns.mock.calls[0], [
        "agent-cursor-agent-sdk-test",
        { runtime: "local", cwd: process.cwd(), limit: 1 },
      ]);
      assert.deepStrictEqual(cursorSdkMock.cancelRun.mock.calls[0], [
        "run-stale",
        {
          runtime: "local",
          cwd: process.cwd(),
        },
      ]);
    }).pipe(Effect.provide(layerTest)),
  );
});
