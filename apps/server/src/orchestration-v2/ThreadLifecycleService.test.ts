import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThreadLineage,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadShellSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadLifecycle from "./ThreadLifecycleService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const emptySnapshot: OrchestrationV2ThreadShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 0,
  threads: [],
  archivedThreads: [],
};

// The lifecycle service only reads a shell's id and lineage, so the fixtures
// carry those two fields alone.
const shell = (
  id: ThreadId,
  lineage: OrchestrationV2AppThreadLineage,
): OrchestrationV2ThreadShell => ({ id, lineage }) as OrchestrationV2ThreadShell;

const lineage = (
  parentThreadId: ThreadId | null,
  relationshipToParent: "subagent" | "fork" | null,
  rootThreadId: ThreadId,
): OrchestrationV2AppThreadLineage => ({ parentThreadId, relationshipToParent, rootThreadId });

it.effect("maps application lifecycle operations to V2-native commands", () => {
  const threadId = ThreadId.make("thread_lifecycle_service");
  const commands: Array<string> = [];
  const projection = { thread: { id: threadId } } as OrchestrationV2ThreadProjection;
  const layer = ThreadLifecycle.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) => {
          commands.push(command.type);
          return Effect.succeed({ sequence: commands.length, storedEvents: [] });
        },
        getThreadRecords: () => Effect.succeed(projection),
        getShellSnapshot: () => Effect.succeed(emptySnapshot),
      }),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* ThreadLifecycle.ThreadLifecycleService;
    yield* service.archive({ commandId: CommandId.make("archive"), threadId });
    yield* service.unarchive({ commandId: CommandId.make("unarchive"), threadId });
    yield* service.updateMetadata({ commandId: CommandId.make("metadata"), threadId, title: "T" });
    yield* service.setRuntimeMode({
      commandId: CommandId.make("runtime"),
      threadId,
      runtimeMode: "approval-required",
    });
    yield* service.setInteractionMode({
      commandId: CommandId.make("interaction"),
      threadId,
      interactionMode: "plan",
    });
    yield* service.setModelSelection({
      commandId: CommandId.make("model"),
      threadId,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.2" },
    });
    yield* service.delete({ commandId: CommandId.make("delete"), threadId });
    assert.deepEqual(commands, [
      "thread.archive",
      "thread.unarchive",
      "thread.metadata.update",
      "thread.runtime-mode.set",
      "thread.interaction-mode.set",
      "thread.model-selection.set",
      "thread.delete",
    ]);
  }).pipe(Effect.provide(layer));
});

const targetId = ThreadId.make("thread_target");
const childId = ThreadId.make("thread_child");
const grandchildId = ThreadId.make("thread_grandchild");
const forkId = ThreadId.make("thread_fork");
const unrelatedId = ThreadId.make("thread_unrelated");

const familySnapshot = (location: "active" | "archive"): OrchestrationV2ThreadShellSnapshot => ({
  schemaVersion: 1,
  snapshotSequence: 7,
  threads:
    location === "active"
      ? [
          shell(targetId, lineage(null, null, targetId)),
          shell(childId, lineage(targetId, "subagent", targetId)),
          shell(grandchildId, lineage(childId, "subagent", targetId)),
          shell(forkId, lineage(targetId, "fork", targetId)),
          shell(unrelatedId, lineage(null, null, unrelatedId)),
        ]
      : [],
  archivedThreads:
    location === "archive"
      ? [
          shell(targetId, lineage(null, null, targetId)),
          shell(childId, lineage(targetId, "subagent", targetId)),
          shell(grandchildId, lineage(childId, "subagent", targetId)),
          shell(forkId, lineage(targetId, "fork", targetId)),
          shell(unrelatedId, lineage(null, null, unrelatedId)),
        ]
      : [],
});

it.effect("archive cascades to transitive subagent descendants, target last", () => {
  const dispatches: Array<{ type: "thread.archive" | "thread.unarchive"; threadId: ThreadId }> = [];
  const projection = { thread: { id: targetId } } as OrchestrationV2ThreadProjection;
  const layer = ThreadLifecycle.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        // Suspend so the push happens when the command runs, not when the
        // caller constructs the Effect.
        dispatch: (command) =>
          Effect.suspend(() => {
            if (command.type === "thread.archive" || command.type === "thread.unarchive") {
              dispatches.push(command);
            }
            return Effect.succeed({ sequence: dispatches.length, storedEvents: [] });
          }),
        getThreadRecords: () => Effect.succeed(projection),
        getShellSnapshot: () => Effect.succeed(familySnapshot("active")),
      }),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* ThreadLifecycle.ThreadLifecycleService;
    yield* service.archive({ commandId: CommandId.make("archive"), threadId: targetId });
    assert.deepEqual(
      dispatches.map(({ type, threadId }) => ({ type, threadId })),
      [
        { type: "thread.archive", threadId: childId },
        { type: "thread.archive", threadId: grandchildId },
        { type: "thread.archive", threadId: targetId },
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("unarchive cascades to transitive subagent descendants, target last", () => {
  const dispatches: Array<{ type: "thread.archive" | "thread.unarchive"; threadId: ThreadId }> = [];
  const projection = { thread: { id: targetId } } as OrchestrationV2ThreadProjection;
  const layer = ThreadLifecycle.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        // Suspend so the push happens when the command runs, not when the
        // caller constructs the Effect.
        dispatch: (command) =>
          Effect.suspend(() => {
            if (command.type === "thread.archive" || command.type === "thread.unarchive") {
              dispatches.push(command);
            }
            return Effect.succeed({ sequence: dispatches.length, storedEvents: [] });
          }),
        getThreadRecords: () => Effect.succeed(projection),
        getShellSnapshot: () => Effect.succeed(familySnapshot("archive")),
      }),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* ThreadLifecycle.ThreadLifecycleService;
    yield* service.unarchive({ commandId: CommandId.make("unarchive"), threadId: targetId });
    assert.deepEqual(
      dispatches.map(({ type, threadId }) => ({ type, threadId })),
      [
        { type: "thread.unarchive", threadId: childId },
        { type: "thread.unarchive", threadId: grandchildId },
        { type: "thread.unarchive", threadId: targetId },
      ],
    );
  }).pipe(Effect.provide(layer));
});
