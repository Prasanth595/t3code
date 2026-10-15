/**
 * Runs the adapter against T3's real orchestration layers: the orchestrator,
 * its stores, the effect worker, the launch service and a real git worktree,
 * with the Claude replay transcript from provider-testing standing in for the
 * provider. It answers one question on every upstream sync: does the adapter
 * still work against this upstream?
 */
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  SIMPLE_PROMPT,
  createProject,
  git,
  initRepoWithCommit,
  layerGit,
  layerRuntime,
  projectId,
  runStatusesUntilTerminal,
} from "./contract.testkit.ts";
import * as Sessions from "./sessions.ts";

it.live(
  "launches a thread in a new worktree, reads its status to completion, and starts one thread per command id",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-sessions-" });
        const repo = path.join(base, "repo");
        const worktreesDir = path.join(base, "worktrees");
        yield* fs.makeDirectory(repo);
        yield* fs.makeDirectory(worktreesDir);
        const baseRef = yield* initRepoWithCommit(repo);

        yield* Effect.gen(function* () {
          yield* createProject(repo);

          const sessions = yield* Sessions.FactorySessions;
          assert.strictEqual(yield* sessions.findProject(repo), projectId);
          assert.strictEqual(yield* sessions.findProject(`${repo}/`), null);

          const request: Sessions.LaunchRequest = {
            commandId: "softfac:factory-sessions-contract:attempt-1",
            projectId,
            title: "Factory contract",
            baseRef,
            startFromOrigin: false,
            message: SIMPLE_PROMPT,
            model: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
          };
          const launched = yield* sessions.launch(request);
          const threadId = ThreadId.make(launched.threadId);

          // The worktree is prepared and the provider turn run after launch
          // returns; the run's own events say when it is over.
          assert.strictEqual((yield* runStatusesUntilTerminal(threadId)).at(-1), "completed");

          const status = yield* sessions.status(launched.threadId);
          assert.strictEqual(status.run, "completed");
          assert.strictEqual(status.runOrdinal, 1);
          assert.include(status.lastAssistantMessage ?? "", "fixture simple ok");
          assert.isFalse(status.archived);
          assert.isNotNull(status.branch);
          assert.isNotNull(status.worktreePath);
          const worktreePath = status.worktreePath!;
          assert.isTrue(yield* fs.exists(path.join(worktreePath, ".git")));
          assert.strictEqual(path.dirname(path.dirname(worktreePath)), worktreesDir);
          assert.strictEqual(yield* git(worktreePath, ["branch", "--show-current"]), status.branch);
          assert.strictEqual(
            yield* git(worktreePath, ["rev-parse", "HEAD"]),
            yield* git(repo, ["rev-parse", baseRef]),
          );

          assert.deepStrictEqual(yield* sessions.thread(launched.threadId), {
            worktreePath,
            branch: status.branch,
            archived: false,
          });

          // The same command id again is the same launch: the thread it made,
          // and no second run.
          const again = yield* sessions.launch(request);
          assert.strictEqual(again.threadId, launched.threadId);
          const after = yield* sessions.status(launched.threadId);
          assert.strictEqual(after.runOrdinal, 1);
          assert.strictEqual(after.run, "completed");
        }).pipe(Effect.provide(layerRuntime({ repo, worktreesDir })));
      }),
    ).pipe(Effect.provide(Layer.merge(layerGit, NodeServices.layer))),
);
