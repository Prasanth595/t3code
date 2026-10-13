import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "./config.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { isT3CreatedWorktree } from "./worktreePathTemplate.ts";

const layerTest = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-worktree-template-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  GitVcsDriver.GitVcsDriver.use((driver) =>
    driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 }),
  ).pipe(Effect.map((result) => result.stdout.trim()));

/** A clone in the container layout: `<container>/.bare` plus `<container>/main`. */
const makeContainer = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* fs.makeTempDirectoryScoped({ prefix: "template-source-" });
  yield* git(source, ["init", "--initial-branch=main"]);
  yield* git(source, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=T",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  ]);
  const container = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "template-container-" }),
  );
  yield* git(container, ["clone", "--bare", source, ".bare"]);
  const main = path.join(container, "main");
  yield* git(container, ["--git-dir", ".bare", "worktree", "add", main, "main"]);
  return { container, main };
});

it.layer(layerTest)("worktree path template", (it) => {
  it.effect("places a container worktree next to main, named after the branch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const { container, main } = yield* makeContainer;

      const created = yield* driver.createWorktree(
        { cwd: main, path: null, refName: "main", newRefName: "feat/api/qcdi-1-auth" },
        { worktreePathTemplate: "{repoDir}/{branchLeaf}" },
      );

      assert.equal(created.worktree.path, path.join(container, "qcdi-1-auth"));
      assert.equal(created.worktree.refName, "feat/api/qcdi-1-auth");
      assert.equal(yield* isT3CreatedWorktree(fs, path, created.worktree.path), true);
      assert.equal(yield* isT3CreatedWorktree(fs, path, main), false);
    }),
  );

  it.effect("suffixes a taken name on the branch and the folder together", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const { container, main } = yield* makeContainer;
      const create = driver.createWorktree(
        { cwd: main, path: null, refName: "main", newRefName: "fix-sidebar" },
        { worktreePathTemplate: "{repoDir}/{branchLeaf}", pickFreeName: true },
      );

      yield* create;
      const second = yield* create;

      assert.equal(second.worktree.refName, "fix-sidebar-1");
      assert.equal(second.worktree.path, path.join(container, "fix-sidebar-1"));
    }),
  );

  it.effect("refuses a template that nests the worktree in a normal checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "template-clone-" }),
      );
      yield* git(cwd, ["init", "--initial-branch=main"]);
      yield* git(cwd, [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=T",
        "commit",
        "--allow-empty",
        "-m",
        "init",
      ]);

      const error = yield* driver
        .createWorktree(
          { cwd, path: null, refName: "main", newRefName: "feature" },
          { worktreePathTemplate: "{repoDir}/{branchLeaf}" },
        )
        .pipe(Effect.flip);

      assert.include(error.detail, "is inside");
    }),
  );
});
