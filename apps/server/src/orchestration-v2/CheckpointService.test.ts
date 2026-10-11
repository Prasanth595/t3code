import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ServerSettingsError,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

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

it.effect.each([false, true, "interrupt"] as const)(
  "materializes baseline, lookup fails=%s",
  (lookupFails) => {
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
      Layer.provideMerge(ServerSettings.layerTest()),
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

it.effect(
  "skips capture git operations and materializes missing checkpoints when capture is disabled",
  () => {
    const gitCalls: string[] = [];
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: (cwd) =>
              Effect.sync(() => {
                gitCalls.push(`isGitRepository:${cwd}`);
                return true;
              }),
            hasCheckpointRef: (input) =>
              Effect.sync(() => {
                gitCalls.push(`hasCheckpointRef:${input.checkpointRef}`);
                return true;
              }),
            captureCheckpoint: (input) =>
              Effect.sync(() => {
                gitCalls.push(`captureCheckpoint:${input.checkpointRef}`);
              }),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
      Layer.provideMerge(ServerSettings.layerTest({ checkpointCaptureEnabled: false })),
    );

    return Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 0,
      });
      const captured = yield* checkpoints.capture({
        scope,
        ordinalWithinScope: 1,
        runId: scope.runId!,
        nodeId: scope.nodeId!,
        appRunOrdinal: 1,
        capturedAt: scope.createdAt,
      });

      assert.deepEqual(gitCalls, []);
      assert.equal(baseline.status, "missing");
      assert.equal(captured.status, "missing");
      assert.equal(
        baseline.id,
        CheckpointId.make("checkpoint:scope:checkpoint-scope%3Amaterialize-baseline:name:0"),
      );
      assert.equal(captured.parentCheckpointId, baseline.id);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect(
  "applies checkpoint capture settings per operation without inventing skipped baselines",
  () => {
    const gitCalls: string[] = [];
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: (cwd) =>
              Effect.sync(() => {
                gitCalls.push(`isGitRepository:${cwd}`);
                return true;
              }),
            hasCheckpointRef: (input) =>
              Effect.sync(() => {
                gitCalls.push(`hasCheckpointRef:${input.checkpointRef}`);
                return input.checkpointRef.endsWith("/ordinal/2");
              }),
            captureCheckpoint: (input) =>
              Effect.sync(() => {
                gitCalls.push(`captureCheckpoint:${input.checkpointRef}`);
              }),
            diffCheckpoints: () => Effect.succeed(""),
            listAuthoredPaths: () => Effect.succeed(null),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
      Layer.provideMerge(ServerSettings.layerTest()),
    );

    return Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });
      yield* settings.updateSettings({ checkpointCaptureEnabled: false });
      const skipped = yield* checkpoints.capture({
        scope,
        ordinalWithinScope: 1,
        runId: scope.runId!,
        nodeId: scope.nodeId!,
        appRunOrdinal: 1,
        capturedAt: scope.createdAt,
      });
      yield* settings.updateSettings({ checkpointCaptureEnabled: true });
      const recaptured = yield* checkpoints.capture({
        scope,
        ordinalWithinScope: 2,
        runId: scope.runId!,
        nodeId: scope.nodeId!,
        appRunOrdinal: 2,
        capturedAt: scope.createdAt,
      });

      assert.equal(skipped.status, "missing");
      assert.equal(recaptured.status, "ready");
      assert.deepEqual(
        gitCalls.map((call) =>
          call.replace(/checkpoints\/[^/]+\/ordinal/g, "checkpoints/<scope>/ordinal"),
        ),
        [
          "isGitRepository:/repo",
          "hasCheckpointRef:refs/t3/orchestration-v2/checkpoints/<scope>/ordinal/0",
          "captureCheckpoint:refs/t3/orchestration-v2/checkpoints/<scope>/ordinal/0",
          "isGitRepository:/repo",
          "captureCheckpoint:refs/t3/orchestration-v2/checkpoints/<scope>/ordinal/2",
          "hasCheckpointRef:refs/t3/orchestration-v2/checkpoints/<scope>/ordinal/1",
        ],
      );
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect.each(["baseline", "materialize", "capture"] as const)(
  "does not touch Git when settings are unavailable during %s",
  (operation) => {
    const error = new ServerSettingsError({
      settingsPath: "/settings.json",
      operation: "read-file",
    });
    const isGitRepository = vi.fn(() => Effect.succeed(true));
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          NodeCrypto.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({ isGitRepository }),
          Layer.mock(ServerSettings.ServerSettingsService)({ getSettings: Effect.fail(error) }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const result = yield* (
        operation === "baseline"
          ? checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 })
          : operation === "materialize"
            ? checkpoints.materializeBaselineCheckpoint({ scope, ordinalWithinScope: 0 })
            : checkpoints.capture({
                scope,
                ordinalWithinScope: 1,
                runId: scope.runId!,
                nodeId: scope.nodeId!,
                appRunOrdinal: 1,
                capturedAt: scope.createdAt,
              })
      ).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.strictEqual(result._tag === "Failure" ? result.failure.cause : undefined, error);
      assert.equal(isGitRepository.mock.calls.length, 0);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("restores a ready checkpoint while checkpoint capture is disabled", () => {
  const restoredRefs: string[] = [];
  const layerTest = CheckpointService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        Layer.mock(CheckpointStore.CheckpointStore)({
          restoreCheckpoint: (input) =>
            Effect.sync(() => {
              restoredRefs.push(input.checkpointRef);
              return true;
            }),
        }),
      ),
    ),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(ServerSettings.layerTest({ checkpointCaptureEnabled: false })),
  );

  return Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const checkpoint = yield* checkpoints.materializeBaselineCheckpoint({
      scope,
      ordinalWithinScope: 0,
    });
    yield* checkpoints.restore({
      scope,
      checkpoint: { ...checkpoint, status: "ready" },
    });

    assert.deepEqual(
      restoredRefs.map((ref) =>
        ref.replace(/checkpoints\/[^/]+\/ordinal/g, "checkpoints/<scope>/ordinal"),
      ),
      ["refs/t3/orchestration-v2/checkpoints/<scope>/ordinal/0"],
    );
  }).pipe(Effect.provide(layerTest));
});
