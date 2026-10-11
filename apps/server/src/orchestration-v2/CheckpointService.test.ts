import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

it.effect.each([false, true, "interrupt"] as const)(
  "materializes baseline, lookup fails=%s",
  (lookupFails) => {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:materialize-baseline"),
      threadId: ThreadId.make("thread:materialize-baseline"),
      runId: RunId.make("run:materialize-baseline:3"),
      nodeId: NodeId.make("node:materialize-baseline:3"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:materialize-baseline"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const hasCheckpointRef = vi.fn((_input: CheckpointStore.RestoreCheckpointInput) =>
      lookupFails === "interrupt"
        ? Effect.interrupt
        : lookupFails
          ? Effect.fail(
              new VcsProcessTimeoutError({
                operation: "test.ref",
                command: "git",
                cwd: "/repo",
                timeoutMs: 30000,
              }),
            )
          : Effect.succeed(true),
    );
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef,
            captureCheckpoint: () => Effect.void,
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );

    return Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      if (lookupFails === "interrupt") {
        const exit = yield* Effect.exit(
          checkpoints.materializeBaselineCheckpoint({ scope, ordinalWithinScope: 2 }),
        );
        assert.isTrue(Exit.hasInterrupts(exit));
        const captureExit = yield* Effect.exit(
          checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          }),
        );
        assert.isTrue(Exit.hasInterrupts(captureExit));
        return;
      }
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 2,
      });

      assert.equal(baseline.ordinalWithinScope, 2);
      assert.equal(
        baseline.ref,
        yield* CheckpointService.checkpointRefForScopeOrdinal({
          scopeId: scope.id,
          ordinalWithinScope: 2,
        }),
      );
      assert.equal(baseline.status, lookupFails ? "missing" : "ready");
      assert.deepEqual(hasCheckpointRef.mock.calls[0]?.[0], {
        cwd: scope.cwd,
        checkpointRef: baseline.ref,
      });
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect.each([
  ["capture", "failure"],
  ["capture", "interrupt"],
  ["baseline", "failure"],
  ["baseline", "interrupt"],
] as const)("releases workspace lock after %s/%s and admits a later baseline", ([stage, mode]) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const cleaned = yield* Deferred.make<void>();
    const fail = yield* Deferred.make<void>();
    const nextStarted = yield* Deferred.make<void>();
    let captures = 0;
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("scope:hang"),
      threadId: ThreadId.make("thread:hang"),
      runId: RunId.make("run:hang"),
      nodeId: NodeId.make("node:hang"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:hang"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo",
      createdAt: DateTime.makeUnsafe("2026-10-11T00:00:00Z"),
    };
    const layer = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          NodeCrypto.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef: () => Effect.succeed(false),
            captureCheckpoint: () =>
              Effect.suspend(() =>
                ++captures === 1
                  ? Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(
                        mode === "failure"
                          ? Deferred.await(fail).pipe(
                              Effect.andThen(
                                Effect.fail(
                                  new VcsProcessTimeoutError({
                                    operation: "GitVcsDriver.checkpoints.captureCheckpoint",
                                    command: "git",
                                    cwd: scope.cwd,
                                    timeoutMs: 30000,
                                  }),
                                ),
                              ),
                            )
                          : Effect.never,
                      ),
                      Effect.ensuring(Deferred.succeed(cleaned, undefined)),
                    )
                  : Deferred.succeed(nextStarted, undefined).pipe(Effect.asVoid),
              ),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* CheckpointService.CheckpointServiceV2;
      const first = yield* (
        stage === "baseline"
          ? service.captureBaseline({ scope, ordinalWithinScope: 0 })
          : service
              .capture({
                scope,
                ordinalWithinScope: 1,
                runId: scope.runId!,
                nodeId: scope.nodeId!,
                appRunOrdinal: 1,
                capturedAt: scope.createdAt,
              })
              .pipe(
                Effect.tap((checkpoint) =>
                  Effect.sync(() => assert.equal(checkpoint.status, "error")),
                ),
                Effect.asVoid,
              )
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const next = yield* service
        .captureBaseline({
          scope: { ...scope, threadId: ThreadId.make("thread:next") },
          ordinalWithinScope: 1,
        })
        .pipe(Effect.forkChild);
      // A subprocess timeout or cancellation must finish cleanup before releasing
      // the workspace to another thread. No new total-operation deadline is used.
      if (mode === "failure") yield* Deferred.succeed(fail, undefined);
      if (mode === "interrupt") yield* Fiber.interrupt(first);
      const exit = yield* Fiber.await(first);
      if (stage === "capture" && mode === "failure") {
        assert.isTrue(Exit.isSuccess(exit));
      } else {
        assert.equal(exit._tag, "Failure");
      }
      yield* Deferred.await(cleaned);
      yield* Deferred.await(nextStarted);
      yield* Fiber.join(next);
      assert.equal(captures, 2);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);
