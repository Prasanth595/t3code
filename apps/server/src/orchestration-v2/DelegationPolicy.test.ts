import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import type { MigrationError } from "effect/sql/Migrator";
import type { SqlError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import * as EventSink from "./EventSink.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const unsupportedId = ProviderInstanceId.make("other");
const modelSelection = { instanceId, model: "test" };
const adapter = (driver: string, id = instanceId) =>
  ({
    instanceId: id,
    driver: ProviderDriverKind.make(driver),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Admission must not start a provider"),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const testLayer = (
  enabled = true,
  databaseLayer: Layer.Layer<
    SqlClient.SqlClient,
    MigrationError | PlatformError.PlatformError | SqlError
  > = database,
) =>
  Layer.mergeAll(
    ProjectionStore.layer,
    ProviderReplayHarness.layerWithRegistry(
      { name: "delegation-policy" },
      ProviderAdapterRegistry.layerFromAdapters([
        adapter("codex"),
        adapter("other", unsupportedId),
      ]),
      {
        databaseLayer,
        runEffectWorker: false,
        ...(enabled
          ? { delegationPolicy: { maxDepth: 1 as const, maxActive: 2, maxTotal: 3 } }
          : {}),
      },
    ),
  ).pipe(Layer.provideMerge(databaseLayer));

const parentId = ThreadId.make("policy-root");
const startRoot = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-root"),
    threadId: parentId,
    projectId: ProjectId.make("policy-project"),
    title: "Root",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("start-root"),
    threadId: parentId,
    messageId: MessageId.make("root-message"),
    text: "Delegate",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
});
const request = (id: string, parentThreadId = parentId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parent = yield* projections.getThreadRecords(parentThreadId, ["runs"]);
    const run = parent.runs[0]!;
    return {
      type: "delegated_task.request",
      commandId: CommandId.make(id),
      parentThreadId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId!,
      task: "One bounded task",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      workspaceStrategy: { type: "worktree", baseRef: "HEAD", startFromOrigin: false },
    } satisfies OrchestrationV2Command;
  });
const code = (result: Result.Result<unknown, Orchestrator.OrchestratorV2Error>) => {
  assert.isTrue(Result.isFailure(result));
  if (!Result.isFailure(result)) return undefined;
  assert.equal(result.failure._tag, "DelegationPolicyError");
  return result.failure._tag === "DelegationPolicyError" ? result.failure.code : undefined;
};

it.effect(
  "admits roots, counts pending preparation, rejects children and unsupported providers before effects",
  () =>
    Effect.gen(function* () {
      yield* startRoot;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const accepted = yield* orchestrator.dispatch(yield* request("one"));
      const replay = yield* orchestrator.dispatch(yield* request("one"));
      assert.equal(replay.sequence, accepted.sequence);
      assert.deepEqual(yield* projections.getDelegationBudget(parentId), { active: 1, total: 1 });
      const parent = yield* projections.getThreadRecords(parentId, ["subagents"]);
      const childId = parent.subagents[0]!.childThreadId!;
      const sink = yield* EventSink.EventSinkV2;
      const beforeRefusals = yield* sink.latestSequence();
      const childRequest = yield* request("nested", childId);
      assert.equal(
        code(yield* orchestrator.dispatch(childRequest).pipe(Effect.result)),
        "delegation_depth_exceeded",
      );
      const unsupported = {
        ...(yield* request("unsupported")),
        modelSelection: { instanceId: unsupportedId, model: "test" },
      };
      assert.equal(
        code(yield* orchestrator.dispatch(unsupported).pipe(Effect.result)),
        "delegation_enforcement_unsupported",
      );
      assert.deepEqual(yield* projections.getDelegationBudget(parentId), { active: 1, total: 1 });
      assert.equal(yield* sink.latestSequence(), beforeRefusals);
      // The only child is still preparing. Refusals committed no child/workspace/provider-start events.
      assert.equal(
        (yield* projections.getThreadRecords(parentId, ["subagents"])).subagents.length,
        1,
      );
    }).pipe(Effect.provide(testLayer())),
);

it.effect("serializes concurrent admissions and never refunds accepted lifetime launches", () =>
  Effect.gen(function* () {
    yield* startRoot;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const requests = yield* Effect.forEach(["a", "b", "c", "d"], (id) => request(id));
    const results = yield* Effect.forEach(
      requests,
      (command) => orchestrator.dispatch(command).pipe(Effect.result),
      { concurrency: 4 },
    );
    assert.equal(results.filter(Result.isSuccess).length, 2);
    assert.equal(results.filter(Result.isFailure).length, 2);
    for (const result of results.filter(Result.isFailure))
      assert.equal(code(result), "delegation_budget_exceeded");
    assert.deepEqual(yield* projections.getDelegationBudget(parentId), { active: 2, total: 2 });
    const parent = yield* projections.getThreadRecords(parentId, ["subagents"]);
    // Failed and cancelled preparations free concurrency; their launch records remain durable.
    for (const [index, task] of parent.subagents.entries()) {
      if (index === 0) {
        const child = yield* projections.getThreadRecords(task.childThreadId!, ["runs"]);
        yield* orchestrator.dispatch({
          type: "prepared-run.fail",
          commandId: CommandId.make("fail-prep"),
          threadId: task.childThreadId!,
          runId: child.runs[0]!.id,
          failure: makeProviderFailure({
            message: "Test preparation failed",
            class: "validation_error",
            retryable: false,
          }),
        });
      } else {
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`stop-${index}`),
          threadId: task.childThreadId!,
        });
      }
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.stream({ threadId: parentId, afterSequence: 0 }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === task.id &&
            (stored.event.payload.status === "failed" ||
              stored.event.payload.status === "cancelled" ||
              stored.event.payload.status === "interrupted"),
        ),
        Stream.runHead,
      );
    }
    assert.deepEqual(yield* projections.getDelegationBudget(parentId), { active: 0, total: 2 });
    yield* orchestrator.dispatch(yield* request("third"));
    const thirdParent = yield* projections.getThreadRecords(parentId, ["subagents"]);
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-third"),
      threadId: thirdParent.subagents.at(-1)!.childThreadId!,
    });
    const sink = yield* EventSink.EventSinkV2;
    const thirdTask = thirdParent.subagents.at(-1)!;
    yield* sink.stream({ threadId: parentId, afterSequence: 0 }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "subagent.updated" &&
          stored.event.payload.id === thirdTask.id &&
          (stored.event.payload.status === "cancelled" ||
            stored.event.payload.status === "interrupted"),
      ),
      Stream.runHead,
    );
    assert.equal(
      code(yield* orchestrator.dispatch(yield* request("fourth")).pipe(Effect.result)),
      "delegation_budget_exceeded",
    );
    assert.deepEqual(yield* projections.getDelegationBudget(parentId), { active: 0, total: 3 });
    // Rebuild the orchestrator and projections against the same durable records.
    const sql = yield* SqlClient.SqlClient;
    const acceptedRequest = requests[results.findIndex(Result.isSuccess)]!;
    yield* Effect.gen(function* () {
      const restarted = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* restarted.dispatch(acceptedRequest);
      assert.deepEqual(yield* projections.getDelegationBudget(parentId), { active: 0, total: 3 });
      assert.equal(
        code(yield* restarted.dispatch(yield* request("after-restart")).pipe(Effect.result)),
        "delegation_budget_exceeded",
      );
    }).pipe(Effect.provide(testLayer(true, Layer.succeed(SqlClient.SqlClient, sql))));
  }).pipe(Effect.provide(testLayer())),
);

it.effect("preserves unrestricted nested delegation and unsupported targets when disabled", () =>
  Effect.gen(function* () {
    yield* startRoot;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch(yield* request("root-child"));
    const childId = (yield* projections.getThreadRecords(parentId, ["subagents"])).subagents[0]!
      .childThreadId!;
    yield* orchestrator.dispatch({
      ...(yield* request("nested-child", childId)),
      modelSelection: { instanceId: unsupportedId, model: "test" },
    });
    assert.deepEqual(yield* projections.getDelegationBudget(parentId), { active: 2, total: 2 });
  }).pipe(Effect.provide(testLayer(false))),
);

it.live("reopening SQLite preserves accepted child counts and idempotent receipts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-delegation-budget-" });
      const disk = SqlitePersistence.layerFromPath(`${directory}/state.sqlite`).pipe(
        Layer.provide(NodeServices.layer),
      );
      const accepted = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* startRoot;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const command = yield* request("disk-first");
          const receipt = yield* orchestrator.dispatch(command);
          return { command, sequence: receipt.sequence };
        }).pipe(Effect.provide(testLayer(true, disk))),
      );
      // A new connection and service scope, after the first connection has closed.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          assert.equal(
            (yield* orchestrator.dispatch(accepted.command)).sequence,
            accepted.sequence,
          );
          assert.deepEqual(yield* projections.getDelegationBudget(parentId), {
            active: 1,
            total: 1,
          });
          yield* orchestrator.dispatch(yield* request("disk-second"));
          assert.deepEqual(yield* projections.getDelegationBudget(parentId), {
            active: 2,
            total: 2,
          });
          assert.equal(
            code(yield* orchestrator.dispatch(yield* request("disk-third")).pipe(Effect.result)),
            "delegation_budget_exceeded",
          );
        }).pipe(Effect.provide(testLayer(true, disk))),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
