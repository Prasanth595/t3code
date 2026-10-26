import { it, assert } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Net from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ProjectScriptPorts from "./ProjectScriptPorts.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";

const threadId = ThreadId.make("preview-thread");
const projectId = ProjectId.make("preview-project");

const testLayer = (probe: (port: number) => Effect.Effect<boolean>) =>
  ProjectScriptPorts.layer.pipe(
    Layer.provide(
      Layer.mock(Net.NetService)({
        isPortAvailableOnLoopback: probe,
      }),
    ),
    Layer.provide(Path.layer),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: (id) =>
          Effect.succeed(
            id === threadId
              ? { ...liveThreadShell(id), projectId, worktreePath: "/worktree-119" }
              : null,
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getShell: () =>
          Effect.succeedSome({
            id: projectId,
            title: "Project",
            workspaceRoot: "/repo",
            repositoryIdentity: null,
            defaultModelSelection: null,
            scripts: [
              {
                id: "dev",
                name: "Dev",
                command: "vp dev",
                icon: "play",
                runOnWorktreeCreate: false,
                previewUrl: "http://localhost:${T3CODE_PREVIEW_PORT}",
              },
              {
                id: "fixed",
                name: "Fixed",
                command: "vp dev",
                icon: "play",
                runOnWorktreeCreate: false,
              },
            ],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
      }),
    ),
  );

it.effect("ProjectScriptPorts-fabricatedLookup-reservesOnlySavedThreadActions", () => {
  const probes: number[] = [];
  return Effect.gen(function* () {
    const service = yield* ProjectScriptPorts.ProjectScriptPorts;
    for (const cwd of ["/fabricated-one", "/fabricated-two"]) {
      const input = { threadId, cwd, scriptIds: ["invented", "fixed"] };
      assert.deepEqual(yield* service.get(input), { ports: {} });
    }
    const input = { threadId, cwd: "/worktree-119", scriptIds: ["dev", "invented", "fixed"] };
    assert.deepEqual(yield* service.get(input), { ports: { dev: 27170 } });
    assert.deepEqual(yield* service.get(input), { ports: { dev: 27170 } });
    const missing = {
      threadId: ThreadId.make("missing"),
      cwd: "/fabricated-three",
      scriptIds: ["invented"],
    };
    assert.deepEqual(yield* service.get(missing), { ports: {} });
    assert.deepEqual(probes, [27170]);
  }).pipe(
    Effect.provide(
      testLayer((port) =>
        Effect.sync(() => {
          probes.push(port);
          return true;
        }),
      ),
    ),
  );
});

it.effect("ProjectScriptPorts-concurrentCollisions-keepsDistinctStableAssignments", () => {
  const probes: number[] = [];
  let available = true;
  return Effect.gen(function* () {
    const probeEntered = yield* Deferred.make<void>();
    const releaseProbe = yield* Deferred.make<void>();
    const layer = testLayer((port) =>
      Effect.gen(function* () {
        probes.push(port);
        if (probes.length === 1) {
          yield* Deferred.succeed(probeEntered, undefined);
          yield* Deferred.await(releaseProbe);
        }
        return available;
      }),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ProjectScriptPorts.ProjectScriptPorts;
      const first = yield* service
        .reserve({ cwd: "/worktree-119", scriptId: "dev" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(probeEntered);
      const contenders = yield* Effect.all(
        [
          service.reserve({ cwd: "/worktree-151", scriptId: "dev" }),
          service.reserve({ cwd: "/worktree-119/../worktree-119", scriptId: "dev" }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.deepEqual(probes, [27170]);
      yield* Deferred.succeed(releaseProbe, undefined);
      const ports = [yield* Fiber.join(first), ...(yield* Fiber.join(contenders))];
      assert.deepEqual(ports, [27170, 27171, 27170]);
      assert.deepEqual(probes, [27170, 27171]);
      available = false;
      assert.equal(yield* service.reserve({ cwd: "/worktree-119", scriptId: "dev" }), 27170);
      assert.equal(probes.length, 2);
    }).pipe(Effect.provide(layer));
  });
});

it.effect("ProjectScriptPorts-occupiedPreferredPort-wrapsAndRestartsDeterministically", () => {
  const layer = testLayer((port) => Effect.succeed(port !== 29999));
  const allocate = Effect.gen(function* () {
    const service = yield* ProjectScriptPorts.ProjectScriptPorts;
    return yield* Effect.forEach(["dev-7202", "dev", "test", "dev"], (scriptId) =>
      service.reserve({ cwd: "/repo", scriptId }),
    );
  });
  return Effect.gen(function* () {
    const first = yield* allocate.pipe(Effect.provide(layer));
    const restarted = yield* allocate.pipe(Effect.provide(layer));
    assert.deepEqual(first, [20000, 24299, 27532, 24299]);
    assert.deepEqual(restarted, first);
  });
});

it.effect("ProjectScriptPorts-exhaustedRange-failsWithoutPoisoningRetries", () => {
  let available = false;
  let probes = 0;
  return Effect.gen(function* () {
    const service = yield* ProjectScriptPorts.ProjectScriptPorts;
    const input = { cwd: "/repo", scriptId: "dev" };
    const error = yield* service.reserve(input).pipe(Effect.flip);
    assert.equal(error._tag, "ProjectScriptPortUnavailableError");
    assert.equal(error.startPort, 24299);
    assert.equal(error.attempts, 10000);
    assert.equal(probes, 10000);
    available = true;
    assert.equal(yield* service.reserve(input), 24299);
  }).pipe(
    Effect.provide(
      testLayer(() =>
        Effect.sync(() => {
          probes++;
          return available;
        }),
      ),
    ),
  );
});
