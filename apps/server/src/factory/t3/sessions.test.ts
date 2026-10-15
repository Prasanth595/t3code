// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - the recorded snapshot is read as the wire bytes softfac saw.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as Sessions from "./sessions.ts";

// ---- status: the run, its message and the thread fields, read from a projection ----

const thread = (
  branch: string | null = null,
  worktreePath: string | null = null,
  archivedAt: string | null = null,
) => ({ branch, worktreePath, archivedAt });

const run = (ordinal: number, status: Sessions.RunStatus) => ({
  id: `run-${ordinal}`,
  ordinal,
  status,
  startedAt: "2026-10-05T06:39:38.376Z",
});

/** A run that was queued and never started: T3 gives it no `startedAt`. */
const unstartedRun = (ordinal: number, status: Sessions.RunStatus) => ({
  id: `run-${ordinal}`,
  ordinal,
  status,
  startedAt: null,
});

/** A message of the run with `ordinal`, which T3 references by the run's `id`. */
const message = (ordinal: number | null, role: string, text: string) => ({
  role,
  text,
  runId: ordinal === null ? null : `run-${ordinal}`,
});

const statusOf = (
  runs: ReadonlyArray<Sessions.ThreadSnapshot["runs"][number]>,
  messages: ReadonlyArray<Sessions.ThreadSnapshot["messages"][number]> = [],
  fields = thread(),
) => Sessions.threadStatusOf({ thread: fields, runs, messages });

describe("threadStatusOf", () => {
  it("reads a real recorded snapshot and ignores unknown fields", () => {
    const snapshot = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(import.meta.dirname, "fixtures", "t3_thread_snapshot.json"),
        "utf8",
      ),
    ) as { readonly projection: Sessions.ThreadSnapshot };
    assert.deepStrictEqual(Sessions.threadStatusOf(snapshot.projection), {
      run: "completed",
      runOrdinal: 1,
      lastAssistantMessage: "READY",
      worktreePath: "/tmp/t3-spike-home/worktrees/t3-spike-repo/t3code-618ff943",
      branch: "t3code/618ff943",
      archived: false,
    });
  });

  it("takes the run with the highest ordinal whatever the order", () => {
    // The highest ordinal is in the middle, so first, last and lowest all get it wrong.
    const status = statusOf([run(1, "completed"), run(3, "running"), run(2, "failed")]);
    assert.strictEqual(status.run, "running");
  });

  it("skips a cancelled run that never started", () => {
    // Run 1 is working; the person's queued message became run 2 and was cancelled.
    const active: ReadonlyArray<Sessions.RunStatus> = [
      "preparing",
      "queued",
      "starting",
      "running",
      "waiting",
    ];
    for (const expected of active) {
      // The cancelled run comes first, so "last in the array" gets it wrong too.
      const status = statusOf([unstartedRun(2, "cancelled"), run(1, expected)]);
      assert.strictEqual(status.run, expected, expected);
      assert.strictEqual(status.runOrdinal, 1, expected);
    }
  });

  it("keeps the finished run and its message behind a cancelled queued run", () => {
    const status = statusOf(
      [run(1, "completed"), unstartedRun(2, "cancelled")],
      [
        message(1, "user", "do the work"),
        message(1, "assistant", "all done. FACTORY-DONE: ready"),
        message(2, "user", "continue the work"),
      ],
    );
    assert.strictEqual(status.run, "completed");
    assert.strictEqual(status.runOrdinal, 1);
    assert.strictEqual(status.lastAssistantMessage, "all done. FACTORY-DONE: ready");
  });

  it("of a sole cancelled run that never started is cancelled", () => {
    const status = statusOf([unstartedRun(1, "cancelled")]);
    assert.strictEqual(status.run, "cancelled");
    assert.strictEqual(status.runOrdinal, 1);
  });

  it("of a sole cancelled run that started is cancelled", () => {
    const status = statusOf([run(1, "cancelled")]);
    assert.strictEqual(status.run, "cancelled");
    assert.strictEqual(status.runOrdinal, 1);
  });

  it("lets a cancelled run that started decide", () => {
    const status = statusOf([run(1, "completed"), run(2, "cancelled")]);
    assert.strictEqual(status.run, "cancelled");
    assert.strictEqual(status.runOrdinal, 2);
  });

  it("skips every cancelled run that never started", () => {
    const status = statusOf([
      unstartedRun(3, "cancelled"),
      run(1, "running"),
      unstartedRun(2, "cancelled"),
    ]);
    assert.strictEqual(status.run, "running");
    assert.strictEqual(status.runOrdinal, 1);
  });

  it("takes the highest ordinal when every run is cancelled and never started", () => {
    // The highest ordinal comes first, so "last in the array" gets it wrong too.
    const status = statusOf([unstartedRun(2, "cancelled"), unstartedRun(1, "cancelled")]);
    assert.strictEqual(status.run, "cancelled");
    assert.strictEqual(status.runOrdinal, 2);
  });

  it("keeps a queued run that has not started yet", () => {
    // Only a cancelled run is left out: a message still waiting in the queue is the
    // thread's run.
    const status = statusOf([unstartedRun(2, "queued"), run(1, "completed")]);
    assert.strictEqual(status.run, "queued");
    assert.strictEqual(status.runOrdinal, 2);
  });

  it("treats a cancelled run without startedAt as never started", () => {
    const status = statusOf([{ id: "run-2", ordinal: 2, status: "cancelled" }, run(1, "running")]);
    assert.strictEqual(status.run, "running");
    assert.strictEqual(status.runOrdinal, 1);
  });

  it("reports the ordinal of the run it describes", () => {
    // Out of order, with the highest in the middle: the status and the ordinal are of the
    // same run.
    const status = statusOf([run(4, "completed"), run(9, "running"), run(2, "failed")]);
    assert.strictEqual(status.run, "running");
    assert.strictEqual(status.runOrdinal, 9);
  });

  it("without runs has no run and no run ordinal", () => {
    const status = statusOf([]);
    assert.strictEqual(status.run, null);
    assert.strictEqual(status.runOrdinal, null);
    assert.strictEqual(status.lastAssistantMessage, null);
  });

  it("maps every known run status", () => {
    for (const status of Sessions.RUN_STATUSES) {
      assert.strictEqual(statusOf([run(1, status)]).run, status, status);
    }
  });

  it("reports only the reported run's own last assistant message", () => {
    // A run that ended quietly must not be read as ending with an older run's result
    // line, and a message with no run reference is no run's.
    const status = statusOf(
      [run(1, "completed"), run(2, "completed")],
      [
        message(1, "assistant", "FACTORY-DONE: old"),
        message(2, "user", "go again"),
        message(null, "assistant", "orphan"),
      ],
    );
    assert.strictEqual(status.runOrdinal, 2);
    assert.strictEqual(status.lastAssistantMessage, null);
  });

  it("reports the last of the run's assistant messages, not the first", () => {
    // A real run says something on the way ("looking") before its result line.
    const status = statusOf(
      [run(1, "completed")],
      [
        message(1, "assistant", "looking"),
        message(1, "user", "carry on"),
        message(1, "assistant", "FACTORY-DONE: ready"),
      ],
    );
    assert.strictEqual(status.lastAssistantMessage, "FACTORY-DONE: ready");
  });

  it("reports the thread's branch, worktree path and whether it is archived", () => {
    const status = statusOf([], [], thread("t3/abc", "/tmp/wt", "2026-10-05T06:39:38.376Z"));
    assert.strictEqual(status.branch, "t3/abc");
    assert.strictEqual(status.worktreePath, "/tmp/wt");
    assert.strictEqual(status.archived, true);
    assert.strictEqual(statusOf([], [], thread()).archived, false);
  });
});

// ---- the service over T3's stores ----

const projectId = ProjectId.make("project:factory-sessions-test");
const threadId = ThreadId.make("thread:project:factory-sessions-test:1");

const projectCreated = (id: string, workspaceRoot: string, sequence: number) =>
  ({
    sequence,
    eventId: EventId.make(`event:${id}:created`),
    aggregateKind: "project",
    aggregateId: ProjectId.make(id),
    occurredAt: "2026-10-03T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: ProjectId.make(id),
      title: id,
      workspaceRoot,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-03T00:00:00.000Z",
      updatedAt: "2026-10-03T00:00:00.000Z",
    },
  }) as const;

const projectDeleted = (id: string, sequence: number) =>
  ({
    sequence,
    eventId: EventId.make(`event:${id}:deleted`),
    aggregateKind: "project",
    aggregateId: ProjectId.make(id),
    occurredAt: "2026-10-03T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.deleted",
    payload: { projectId: ProjectId.make(id), deletedAt: "2026-10-03T00:00:00.000Z" },
  }) as const;

const layerProjects = ProjectStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));

const layerSessions = (
  projections: Partial<ProjectionStore.ProjectionStoreV2["Service"]> = {},
  launches: Partial<ThreadLaunch.ThreadLaunchService["Service"]> = {},
) =>
  Layer.mergeAll(
    Sessions.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerProjects,
          Layer.mock(ProjectionStore.ProjectionStoreV2)(projections),
          Layer.mock(ThreadLaunch.ThreadLaunchService)(launches),
        ),
      ),
    ),
    layerProjects,
  );

describe("FactorySessions.findProject", () => {
  it.effect("returns the id of the matching workspace root", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply(projectCreated("p-other", "/tmp/other", 1));
      yield* projects.apply(projectCreated("p-spike", "/tmp/t3-spike-repo", 2));
      const sessions = yield* Sessions.FactorySessions;
      assert.strictEqual(yield* sessions.findProject("/tmp/t3-spike-repo"), "p-spike");
    }).pipe(Effect.provide(layerSessions())),
  );

  it.effect("without a match is null", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply(projectCreated("p-other", "/tmp/other", 1));
      const sessions = yield* Sessions.FactorySessions;
      assert.strictEqual(yield* sessions.findProject("/tmp/t3-spike-repo"), null);
    }).pipe(Effect.provide(layerSessions())),
  );

  it.effect("ignores deleted projects", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply(projectCreated("p-old", "/tmp/t3-spike-repo", 1));
      yield* projects.apply(projectDeleted("p-old", 2));
      const sessions = yield* Sessions.FactorySessions;
      assert.strictEqual(yield* sessions.findProject("/tmp/t3-spike-repo"), null);
      yield* projects.apply(projectCreated("p-new", "/tmp/t3-spike-repo", 3));
      assert.strictEqual(yield* sessions.findProject("/tmp/t3-spike-repo"), "p-new");
    }).pipe(Effect.provide(layerSessions())),
  );

  it.effect("matches the whole root, not a prefix or a trailing slash", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply(projectCreated("p-a", "/tmp/t3-spike-repo-2", 1));
      yield* projects.apply(projectCreated("p-b", "/tmp/t3-spike-repo/", 2));
      const sessions = yield* Sessions.FactorySessions;
      assert.strictEqual(yield* sessions.findProject("/tmp/t3-spike-repo"), null);
    }).pipe(Effect.provide(layerSessions())),
  );
});

describe("FactorySessions.launch", () => {
  const request: Sessions.LaunchRequest = {
    commandId: "softfac:issue-5:attempt-1",
    projectId,
    title: "Build issue 5",
    baseRef: "main",
    startFromOrigin: true,
    message: "/factory 5",
    model: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
  };

  it.effect(
    "starts a thread in a new worktree, full-access, default interaction, under the caller's command id",
    () =>
      Effect.gen(function* () {
        const inputs: Array<ThreadLaunch.ThreadLaunchInput> = [];
        const launched = yield* Effect.gen(function* () {
          const sessions = yield* Sessions.FactorySessions;
          return yield* sessions.launch(request);
        }).pipe(
          Effect.provide(
            layerSessions(
              {},
              {
                launch: (input) =>
                  Effect.sync(() => {
                    inputs.push(input);
                    return {
                      threadId,
                      resumed: false,
                      projection: {
                        thread: { branch: null, worktreePath: null },
                      } as OrchestrationV2ThreadProjection,
                    };
                  }),
              },
            ),
          ),
        );
        assert.deepStrictEqual(launched, { threadId, worktreePath: null, branch: null });
        assert.strictEqual(inputs.length, 1);
        const input = inputs[0]!;
        assert.strictEqual(input.commandId, "softfac:issue-5:attempt-1");
        assert.strictEqual(input.projectId, projectId);
        assert.strictEqual(input.title, "Build issue 5");
        assert.deepStrictEqual(input.modelSelection, {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-5-5",
        });
        assert.strictEqual(input.runtimeMode, "full-access");
        assert.strictEqual(input.interactionMode, "default");
        assert.deepStrictEqual(input.workspaceStrategy, {
          type: "worktree",
          baseRef: "main",
          startFromOrigin: true,
        });
        assert.strictEqual(input.initialMessage?.text, "/factory 5");
        assert.deepStrictEqual(input.initialMessage?.attachments, []);
        assert.strictEqual(input.threadId, undefined);
        assert.strictEqual(input.reuseExistingThread, undefined);
      }),
  );

  it.effect("reports the branch and worktree path once T3 has them", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      const launched = yield* sessions.launch(request);
      assert.deepStrictEqual(launched, {
        threadId,
        worktreePath: "/tmp/wt/t3-abc",
        branch: "t3/abc",
      });
    }).pipe(
      Effect.provide(
        layerSessions(
          {},
          {
            launch: () =>
              Effect.succeed({
                threadId,
                resumed: true,
                projection: {
                  thread: { branch: "t3/abc", worktreePath: "/tmp/wt/t3-abc" },
                } as OrchestrationV2ThreadProjection,
              }),
          },
        ),
      ),
    ),
  );

  it.effect("rejects a blank command id as a sessions error without reaching T3", () =>
    Effect.gen(function* () {
      let launches = 0;
      const error = yield* Effect.gen(function* () {
        const sessions = yield* Sessions.FactorySessions;
        return yield* Effect.flip(sessions.launch({ ...request, commandId: "  " }));
      }).pipe(
        Effect.provide(
          layerSessions(
            {},
            {
              launch: () =>
                Effect.sync(() => {
                  launches += 1;
                  return {
                    threadId,
                    resumed: false,
                    projection: {
                      thread: { branch: null, worktreePath: null },
                    } as OrchestrationV2ThreadProjection,
                  };
                }),
            },
          ),
        ),
      );
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.strictEqual(error.operation, "launch");
      assert.strictEqual(launches, 0);
    }),
  );

  it.effect("fails as a sessions error when T3 rejects the launch", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      const error = yield* Effect.flip(sessions.launch(request));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.strictEqual(error.operation, "launch");
    }).pipe(
      Effect.provide(
        layerSessions(
          {},
          {
            launch: (input) =>
              Effect.fail(
                new ThreadLaunch.ThreadLaunchError({
                  operation: "resolve-project",
                  commandId: input.commandId,
                  projectId: input.projectId,
                  cause: "Project not found.",
                }),
              ),
          },
        ),
      ),
    ),
  );
});

describe("FactorySessions.status and thread", () => {
  const appThread = (fields: ReturnType<typeof thread>) =>
    ({
      ...fields,
      archivedAt: fields.archivedAt === null ? null : DateTime.makeUnsafe(fields.archivedAt),
    }) as unknown as OrchestrationV2AppThread;

  it.effect("status reads the run, its last assistant message and the thread fields", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      assert.deepStrictEqual(yield* sessions.status(threadId), {
        run: "completed",
        runOrdinal: 2,
        lastAssistantMessage: "FACTORY-DONE: https://example.test/pr/1",
        worktreePath: "/tmp/wt/t3-abc",
        branch: "t3/abc",
        archived: false,
      });
    }).pipe(
      Effect.provide(
        layerSessions({
          getThreadProjection: (id) =>
            Effect.succeed({
              thread: appThread(thread("t3/abc", "/tmp/wt/t3-abc")),
              runs: [run(1, "completed"), run(2, "completed")].map((r) => ({
                ...r,
                threadId: id,
              })),
              messages: [
                message(1, "assistant", "first"),
                message(2, "assistant", "FACTORY-DONE: https://example.test/pr/1"),
              ],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
    ),
  );

  it.effect("status of a thread T3 does not know is not found", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      const error = yield* Effect.flip(sessions.status(threadId));
      assert.strictEqual(error._tag, "FactoryThreadNotFoundError");
      if (error._tag === "FactoryThreadNotFoundError") {
        assert.strictEqual(error.threadId, threadId);
      }
    }).pipe(
      Effect.provide(
        layerSessions({
          getThreadProjection: (id) =>
            Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: id })),
        }),
      ),
    ),
  );

  it.effect("thread reads the thread's own fields and works when the runs cannot be read", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      assert.deepStrictEqual(yield* sessions.thread(threadId), {
        worktreePath: "/tmp/wt/t3-abc",
        branch: "t3/abc",
        archived: true,
      });
      const error = yield* Effect.flip(sessions.status(threadId));
      assert.strictEqual(error._tag, "FactorySessionsError");
    }).pipe(
      Effect.provide(
        layerSessions({
          getThread: () =>
            Effect.succeed(appThread(thread("t3/abc", "/tmp/wt/t3-abc", "2026-10-05T00:00:00Z"))),
          getThreadProjection: (id) =>
            Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId: id,
                cause: new Error("a run row did not decode"),
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("a blank thread id names no thread", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      assert.strictEqual(
        (yield* Effect.flip(sessions.status("")))._tag,
        "FactoryThreadNotFoundError",
      );
      assert.strictEqual(
        (yield* Effect.flip(sessions.thread("  ")))._tag,
        "FactoryThreadNotFoundError",
      );
    }).pipe(
      Effect.provide(
        layerSessions({
          getThread: () => Effect.die("a blank id must not reach the store"),
          getThreadProjection: () => Effect.die("a blank id must not reach the store"),
        }),
      ),
    ),
  );

  it.effect("thread of a thread T3 does not know is not found", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.FactorySessions;
      const error = yield* Effect.flip(sessions.thread(threadId));
      assert.strictEqual(error._tag, "FactoryThreadNotFoundError");
    }).pipe(
      Effect.provide(
        layerSessions({
          getThread: (id) =>
            Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: id })),
        }),
      ),
    ),
  );
});
