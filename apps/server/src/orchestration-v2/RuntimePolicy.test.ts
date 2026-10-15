import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { discoverClaudeSkills } from "../provider/Drivers/ClaudeSkills.ts";
import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

// Grok's instance offers no Auto-accept edits; the Codex instance advertises no
// restriction.
const grokInstanceId = ProviderInstanceId.make("grok");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as ProviderInstance;

const layerForProject = (workspaceRoot: string) =>
  RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.succeed(
            Option.some({
              projectId,
              title: "Project",
              workspaceRoot,
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              createdAt: "2026-06-21T00:00:00.000Z",
              updatedAt: "2026-06-21T00:00:00.000Z",
              deletedAt: null,
            }),
          ),
      }),
    ),
  );

const layerTest = layerForProject("/project-root").pipe(
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      resolveProjectCwd: (input) => Effect.succeed(input.worktreePath ?? input.cwd),
    }),
  ),
);

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("uses the project root for local-checkout threads", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-root");
    }),
  );

  it.effect("prefers a provisioned worktree over the project root", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/project-worktree" }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
    }),
  );

  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      // A provider that advertises no restriction runs every mode as stored.
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );
});

it.layer(
  RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(Option.none()) }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: () => Effect.succeed(undefined),
        }),
        Layer.mock(WorkspacePaths.WorkspacePaths)({}),
      ),
    ),
  ),
)("RuntimePolicyV2 without a project", (it) => {
  it.effect("preserves the existing missing-project error for a local thread", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const error = yield* policy
        .resolve({ thread: makeThread({ now, worktreePath: null }), modelSelection })
        .pipe(Effect.flip);
      assert.instanceOf(error, RuntimePolicy.RuntimePolicyResolveError);
      assert.equal(error.cause, "Project not found.");
    }),
  );

  it.effect("keeps an existing worktree when its project is missing", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/project-worktree" }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
    }),
  );
});

it.effect("keeps the immediate cwd-resolution failure as the policy error cause", () => {
  const cause = new WorkspacePaths.WorkspaceProjectCwdError({
    cwd: "/project-root",
    worktreePath: "/project-worktree",
    cause: new Error("Permission denied"),
  });
  return Effect.gen(function* () {
    const policy = yield* RuntimePolicy.RuntimePolicyV2;
    const now = yield* DateTime.now;
    const error = yield* policy
      .resolve({ thread: makeThread({ now, worktreePath: "/project-worktree" }), modelSelection })
      .pipe(Effect.flip);
    assert.instanceOf(error, RuntimePolicy.RuntimePolicyResolveError);
    assert.strictEqual(error.cause, cause);
  }).pipe(
    Effect.provide(
      layerForProject("/project-root").pipe(
        Layer.provide(
          Layer.mock(WorkspacePaths.WorkspacePaths)({ resolveProjectCwd: () => cause }),
        ),
      ),
    ),
  );
});

it.effect("starts a subdirectory worktree with its project-scoped skills", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const base = yield* fs
      .makeTempDirectoryScoped({ prefix: "t3-worktree-project-cwd-" })
      .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
    const repo = path.join(base, "repo");
    const project = path.join(repo, "ios");
    const worktree = path.join(base, "worktree");
    const skill = path.join(project, ".claude", "skills", "ios-release");
    yield* fs.makeDirectory(skill, { recursive: true });
    yield* fs.writeFileString(
      path.join(skill, "SKILL.md"),
      "---\nname: ios-release\ndescription: Project scoped release skill.\n---\nRelease this project.\n",
    );
    for (const args of [
      ["init", "-q", repo],
      ["-C", repo, "add", "."],
      [
        "-C",
        repo,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      ["-C", repo, "worktree", "add", "-qb", "feature", worktree],
    ]) {
      const result = yield* runner.run({ command: "git", args });
      assert.equal(result.code, 0);
    }
    const now = yield* DateTime.now;
    const resolved = yield* Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      return yield* policy.resolve({
        thread: makeThread({ now, worktreePath: worktree }),
        modelSelection,
      });
    }).pipe(Effect.provide(layerForProject(project).pipe(Layer.provide(WorkspacePaths.layer))));
    assert.equal(resolved.cwd, path.join(worktree, "ios"));
    const skills = yield* discoverClaudeSkills(
      { homePath: path.join(base, "empty-config") },
      resolved.cwd ?? undefined,
      {},
    );
    assert.deepEqual(
      skills.map((entry) => entry.name),
      ["ios-release"],
    );
  }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
