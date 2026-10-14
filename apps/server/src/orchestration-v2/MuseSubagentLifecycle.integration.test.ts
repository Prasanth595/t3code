import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeMuseAdapterV2 } from "@t3tools/provider-muse/server";
import { MuseSettings } from "@t3tools/provider-muse/settings";
import type { MuseSdkHost } from "@t3tools/provider-muse/testing";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("muse");
const modelSelection = { instanceId, model: "muse-spark-1.3-contributor" };
const museSettings = Schema.decodeSync(MuseSettings)({ enabled: true });

// Only the SDK transport is fake. Muse constructs and routes the child artifacts.
const makeMuseHost = Effect.fnUntraced(function* () {
  const started = yield* Queue.unbounded<string>();
  const closed = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<Awaited<MuseSdkHost["exited"]>>();
  let notify: Parameters<MuseSdkHost["connection"]["onNotification"]>[0] = () => {};
  let sequence = 0;
  let nativeSessionId = "";
  let closeCount = 0;
  const host: MuseSdkHost = {
    connection: {
      mintCommandId: () => `muse-command-${++sequence}`,
      command: async (method, params, options) => {
        if (method === "session/start" || method === "session/resume") {
          nativeSessionId = String(params.sessionId);
          return { session: { sessionId: nativeSessionId }, history: { items: [] } };
        }
        if (method === "turn/start") {
          const turnId = options?.commandId ?? "muse-turn";
          Queue.offerUnsafe(started, turnId);
          return { turnId };
        }
        return {};
      },
      request: async () => ({}),
      onNotification: (handler) => {
        notify = handler;
      },
      onProtocolError: () => {},
      onServerRequest: () => {},
      closed: closed.promise,
    },
    initializeResult: { grantedCapabilities: [] },
    exited: exited.promise,
    close: async () => {
      closeCount++;
      closed.resolve();
      exited.resolve({ code: 0, signal: null });
    },
  };
  return {
    host,
    started: Queue.take(started),
    closeCount: () => closeCount,
    reportChild: (turnId: string, suffix: string) =>
      Effect.sync(() =>
        notify({
          jsonrpc: "2.0",
          method: "item/started",
          params: {
            sessionId: nativeSessionId,
            turnId,
            item: {
              itemId: `subagent-${suffix}`,
              kind: "subagent",
              revision: 1,
              status: "inProgress",
              turnId,
              subagentId: `native-subagent-${suffix}`,
              controlStatus: "running",
              childSessionId: `native-child-${suffix}`,
              objective: `Inspect ${suffix}`,
              role: `Inspect ${suffix}`,
            },
          },
        }),
      ),
  };
});

it.effect.each(["archive", "delete"] as const)(
  "applies %s to Muse native children reported before and after the parent command",
  (operation) =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`muse-subagent-${operation}`);
      const fake = yield* makeMuseHost();
      const registry = ProviderAdapterRegistry.layerFromAdaptersEffect(
        makeMuseAdapterV2({
          instanceId,
          settings: museSettings,
          environment: {},
          createHost: async () => fake.host,
        }).pipe(Effect.map((adapter) => [adapter])),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            NodeServices.layer,
            TestProviderHost.layer({ cwd }).pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const parentId = ThreadId.make(`muse-${operation}-parent`);
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-muse-parent"),
          threadId: parentId,
          projectId: ProjectId.make("muse-lifecycle-project"),
          title: "Muse lifecycle parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          worktreePath: cwd,
          branch: null,
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-muse-parent"),
          threadId: parentId,
          messageId: MessageId.make("muse-parent-prompt"),
          text: "Inspect the project",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const turnId = yield* fake.started;
        yield* Fiber.join(running);

        const reportChild = Effect.fnUntraced(function* (suffix: string) {
          const created = yield* watch(
            (event) =>
              event.type === "thread.created" && event.payload.title === `Inspect ${suffix}`,
          );
          yield* fake.reportChild(turnId, suffix);
          const [event] = yield* Fiber.join(created);
          assert.ok(event?.type === "thread.created");
          assert.equal(event.payload.lineage.parentThreadId, parentId);
          assert.equal(event.payload.lineage.relationshipToParent, "subagent");
          return event.threadId;
        });
        const earlyId = yield* reportChild("early");
        yield* orchestrator.dispatch({
          type: `thread.${operation}`,
          commandId: CommandId.make(`muse-parent-${operation}`),
          threadId: parentId,
        });
        // The command committed, but its cascade and SDK detach have not run.
        assert.equal(fake.closeCount(), 0);
        const lateId = yield* reportChild("late");
        const committed = (yield* orchestrator.getThreadProjection(parentId)).thread;
        const late = (yield* orchestrator.getThreadProjection(lateId)).thread;
        assert.isNotNull(operation === "archive" ? committed.archivedAt : committed.deletedAt);
        assert.deepEqual(late.archivedAt, committed.archivedAt);
        assert.deepEqual(late.deletedAt, committed.deletedAt);
        yield* worker.drain();
        assert.equal(fake.closeCount(), 1);
        const parent = (yield* orchestrator.getThreadProjection(parentId)).thread;
        for (const childId of [earlyId, lateId]) {
          const child = yield* orchestrator.getThreadProjection(childId);
          assert.deepEqual(child.thread.archivedAt, parent.archivedAt);
          assert.deepEqual(child.thread.deletedAt, parent.deletedAt);
          assert.lengthOf(child.providerSessions, 0);
        }
        if (operation === "archive") {
          yield* orchestrator.dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make("muse-parent-unarchive"),
            threadId: parentId,
          });
          yield* worker.drain();
          for (const childId of [earlyId, lateId]) {
            const child = yield* orchestrator.getThreadProjection(childId);
            assert.isNull(child.thread.archivedAt);
            assert.isNull(child.thread.deletedAt);
          }
        }
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: `muse-subagent-${operation}` },
            registry,
            { runEffectWorker: false },
          ),
        ),
      );
    }).pipe(Effect.scoped),
);
