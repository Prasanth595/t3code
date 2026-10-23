// @effect-diagnostics nodeBuiltinImport:off - the database is a real file in a temp directory.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe } from "vite-plus/test";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { useTempDirs } from "../ledger/testSupport.ts";
import { type SeededThread, seedProjection } from "./projectionFixture.testkit.ts";
import * as Sessions from "./sessions.ts";

const tempDir = useTempDirs();

/**
 * Sessions over a real database file. Its projection store answers nothing, so a count that goes
 * through a shell snapshot dies; the count must be a query of its own.
 */
const layerSessions = () =>
  Sessions.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ProjectStore.layer,
        ServerSettings.layerTest(),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        NodeServices.layer,
      ),
    ),
    Layer.provideMerge(
      SqlitePersistence.layerFromPath(NodePath.join(tempDir("running"), "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

/** What the factory counted before: the shell snapshot's active threads that are at work. */
const countFromShellSnapshot = Effect.gen(function* () {
  const { threads } = yield* (yield* ProjectionStore.ProjectionStoreV2).getShellSnapshot({
    location: "active",
  });
  return threads.filter(
    ({ activityRunStatus }) =>
      activityRunStatus === "preparing" ||
      activityRunStatus === "starting" ||
      activityRunStatus === "running",
  ).length;
}).pipe(Effect.provide(ProjectionStore.layer));

const FIXTURE: ReadonlyArray<SeededThread> = [
  { runs: [{ ordinal: 1, status: "running" }] },
  { runs: [{ ordinal: 1, status: "preparing" }] },
  { runs: [{ ordinal: 1, status: "starting" }] },
  // Waiting on a person: not at work.
  { runs: [{ ordinal: 1, status: "waiting" }] },
  { runs: [{ ordinal: 1, status: "completed" }] },
  {},
  // Archived and deleted threads never count.
  { archived: true, runs: [{ ordinal: 1, status: "running" }] },
  { deleted: true, runs: [{ ordinal: 1, status: "running" }] },
  // The latest run among those that are not finished decides.
  {
    runs: [
      { ordinal: 1, status: "running" },
      { ordinal: 2, status: "waiting" },
    ],
  },
  {
    runs: [
      { ordinal: 1, status: "waiting" },
      { ordinal: 2, status: "running" },
    ],
  },
  {
    runs: [
      { ordinal: 1, status: "preparing" },
      { ordinal: 2, status: "completed" },
    ],
  },
  {
    runs: [
      { ordinal: 1, status: "completed" },
      { ordinal: 2, status: "completed" },
      { ordinal: 3, status: "starting" },
    ],
  },
  {
    runs: [
      { ordinal: 1, status: "failed" },
      { ordinal: 2, status: "cancelled" },
    ],
  },
];

describe("FactorySessions.runningThreads", () => {
  it.effect("counts what the shell snapshot's active threads said, without taking one", () =>
    Effect.gen(function* () {
      yield* seedProjection(FIXTURE).pipe(Effect.provide(ProjectionStore.layer));
      const expected = yield* countFromShellSnapshot;
      assert.strictEqual(expected, 6);
      assert.strictEqual(yield* (yield* Sessions.FactorySessions).runningThreads, expected);
    }).pipe(Effect.provide(layerSessions())),
  );
});
