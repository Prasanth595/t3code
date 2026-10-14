import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  StoredOrchestrationShellSnapshot,
} from "./orchestrationCache.ts";
import { makeStoredShellSnapshotEncoder } from "./shellCacheEncoding.ts";

const NOW = DateTime.makeUnsafe("2026-07-29T12:00:00.000Z");
const PROJECT_ID = ProjectId.make("project-1");
const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("codex");

const makeThread = (index: number): OrchestrationV2ThreadShell => {
  const id = ThreadId.make(`thread-${index}`);
  return {
    id,
    projectId: PROJECT_ID,
    title: `Thread ${index}`,
    providerInstanceId: PROVIDER_INSTANCE_ID,
    modelSelection: { instanceId: PROVIDER_INSTANCE_ID, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: NOW,
    activityRunStartedAt: null,
    activityRunStatus: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: NOW,
    unsettledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};

const makeStored = (threads: ReadonlyArray<OrchestrationV2ThreadShell>) => ({
  schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
  environmentId: EnvironmentId.make("environment-1"),
  snapshot: {
    schemaVersion: 1 as const,
    snapshotSequence: 3,
    projects: [],
    threads,
    archivedThreads: [],
  },
});

describe("shell cache encoder with a caller-supplied yield", () => {
  const encodeOriginal = Schema.encodeEffect(
    Schema.fromJsonString(StoredOrchestrationShellSnapshot),
  );

  it.effect("keeps output identical to the full encode when only one row changes", () =>
    Effect.gen(function* () {
      let yields = 0;
      const encode = makeStoredShellSnapshotEncoder({
        yieldToHost: Effect.sync(() => {
          yields += 1;
        }),
      });
      const threads = Array.from({ length: 70 }, (_, index) => makeThread(index));
      const first = makeStored(threads);
      expect(yield* encode(first)).toBe(yield* encodeOriginal(first));
      // 70 rows are three 32-row chunks, so the first save yields between them.
      expect(yields).toBeGreaterThanOrEqual(2);

      const second = makeStored([{ ...threads[0]!, title: "Renamed" }, ...threads.slice(1)]);
      expect(yield* encode(second)).toBe(yield* encodeOriginal(second));
    }),
  );

  it.effect("does not yield again when every row was already encoded", () =>
    Effect.gen(function* () {
      let yields = 0;
      const encode = makeStoredShellSnapshotEncoder({
        yieldToHost: Effect.sync(() => {
          yields += 1;
        }),
      });
      const stored = makeStored(Array.from({ length: 70 }, (_, index) => makeThread(index)));
      yield* encode(stored);
      const afterFirst = yields;
      yield* encode(makeStored(stored.snapshot.threads));
      expect(yields).toBe(afterFirst);
    }),
  );
});
