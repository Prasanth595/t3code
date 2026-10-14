import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  TeamId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Binding from "./MissionRetroDispatchBinding.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as MissionService from "./MissionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

it.effect(
  "seals normalized source/runtime bytes and requires a live effective read-only profile",
  () =>
    Effect.gen(function* () {
      let profile = "muse-review";
      const authority = {
        teamId: TeamId.make("team"),
        environmentId: EnvironmentId.make("env"),
        controllerThreadId: ThreadId.make("retro"),
      };
      const layer = Binding.layer.pipe(
        Layer.provide(RuntimePolicy.layer),
        Layer.provide(IdAllocator.layer),
        Layer.provide(Layer.succeed(MissionService.MissionAuthority, authority)),
        Layer.provide(
          Layer.succeed(Binding.MissionRetroRuntimePort, {
            resolve: () =>
              Effect.succeed({
                providerInstanceId: "muse-personal",
                modelId: "muse-spark-1.3-contributor",
                accountId: "account",
                company: "No Fun",
                profile,
                capability: "read_only",
                verified: true,
              }),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const now = yield* DateTime.now;
        const selection = {
          instanceId: ProviderInstanceId.make("muse-personal"),
          model: "muse-spark-1.3-contributor",
          options: [{ id: "profile", value: "muse-review" }],
        };
        const thread: OrchestrationV2AppThread = {
          createdBy: "user",
          creationSource: "web",
          id: authority.controllerThreadId,
          projectId: ProjectId.make("project"),
          title: "Retro",
          providerInstanceId: selection.instanceId,
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/tmp/project",
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: authority.controllerThreadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };
        const command = {
          type: "delegated_task.request" as const,
          commandId: CommandId.make("source"),
          parentThreadId: thread.id,
          parentRunId: RunId.make("parent-run"),
          parentNodeId: NodeId.make("parent-node"),
          task: "Read and report",
          modelSelection: selection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          createdBy: "agent" as const,
          creationSource: "mcp" as const,
        };
        const claim = {
          commandId: CommandId.make("claim"),
          missionId: "mission",
          checkpointId: "checkpoint",
          retroEpoch: 4,
          expectedRevision: 1,
        };
        const binder = yield* Binding.MissionRetroDispatchBinding;
        const prepared = yield* binder.prepare(command, claim, thread);
        assert.isTrue(Object.isFrozen(prepared.command.modelSelection.options));
        assert.match(prepared.sourceCommandDigest, /^[a-f0-9]{64}$/);
        const changed = yield* binder.prepare(
          { ...command, task: "Read another source" },
          claim,
          thread,
        );
        assert.notEqual(changed.sourceCommandDigest, prepared.sourceCommandDigest);
        assert.notEqual(changed.promptHash, prepared.promptHash);
        assert.notEqual(changed.optionsHash, prepared.optionsHash);
        const project = yield* binder.prepare(command, claim, {
          ...thread,
          projectId: ProjectId.make("other-project"),
        });
        assert.notEqual(project.optionsHash, prepared.optionsHash);
        command.task = "Caller mutated the source";
        assert.equal(prepared.command.task, "Read and report");
        assert.isTrue(
          Result.isFailure(yield* binder.recheck(prepared, command, thread).pipe(Effect.result)),
        );
        assert.isTrue(
          Result.isFailure(
            yield* Binding.authenticateRetroDispatch({ ...prepared }).pipe(Effect.result),
          ),
        );
        // The selector remains muse-review. Its live effective profile is the gate.
        profile = "muse-focused";
        assert.isTrue(
          Result.isFailure(
            yield* binder.prepare(prepared.command, claim, thread).pipe(Effect.result),
          ),
        );
      }).pipe(Effect.provide(layer));
    }),
);
