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

  it.effect("avoids branches that block the namespace in either direction", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const { container, main } = yield* makeContainer;
      yield* git(main, ["branch", "t3"]);
      yield* git(main, ["branch", "fix/sidebar"]);
      const options = { worktreePathTemplate: "{repoDir}/{branch}", pickFreeName: true };

      const underBranch = yield* driver.createWorktree(
        { cwd: main, path: null, refName: "main", newRefName: "t3/fix" },
        options,
      );
      const overBranch = yield* driver.createWorktree(
        { cwd: main, path: null, refName: "main", newRefName: "fix" },
        options,
      );

      assert.equal(underBranch.worktree.refName, "t3-fix");
      assert.equal(underBranch.worktree.path, path.join(container, "t3-fix"));
      assert.equal(overBranch.worktree.refName, "fix-1");
    }),
  );

  it.effect("gives concurrent launches with the same name different names", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const { main } = yield* makeContainer;
      const create = driver.createWorktree(
        { cwd: main, path: null, refName: "main", newRefName: "same-words" },
        { worktreePathTemplate: "{repoDir}/{branchLeaf}", pickFreeName: true },
      );

      const created = yield* Effect.all([create, create, create], { concurrency: "unbounded" });

      assert.equal(new Set(created.map((result) => result.worktree.refName)).size, 3);
    }),
  );

  it.effect("gives concurrent launches with clashing namespaces different names", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const { main } = yield* makeContainer;
      const create = (newRefName: string) =>
        driver.createWorktree(
          { cwd: main, path: null, refName: "main", newRefName },
          { worktreePathTemplate: "{repoDir}/{branch}", pickFreeName: true },
        );

      const created = yield* Effect.all([create("fix"), create("fix/sidebar")], {
        concurrency: "unbounded",
      });

      assert.equal(created.length, 2);
    }),
  );

  it.effect("sees a branch that shares its name with a tag", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const { main } = yield* makeContainer;
      yield* git(main, ["branch", "fix"]);
      yield* git(main, ["tag", "fix"]);

      const created = yield* driver.createWorktree(
        { cwd: main, path: null, refName: "main", newRefName: "fix" },
        { worktreePathTemplate: "{repoDir}/{branchLeaf}", pickFreeName: true },
      );

      assert.equal(created.worktree.refName, "fix-1");
    }),
  );

  it.effect("marks a worktree that is created again at its recorded path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const { container, main } = yield* makeContainer;
      yield* git(main, ["branch", "recreated"]);

      const created = yield* driver.createWorktree(
        { cwd: main, path: path.join(container, "recreated"), refName: "recreated" },
        { worktreePathTemplate: "{repoDir}/{branchLeaf}" },
      );

      assert.equal(yield* isT3CreatedWorktree(fs, path, created.worktree.path), true);
    }),
  );

  it.effect("names the taken folder when a typed branch collides on its leaf", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const { main } = yield* makeContainer;
      const options = { worktreePathTemplate: "{repoDir}/{branchLeaf}" };
      yield* driver.createWorktree(
        { cwd: main, path: null, refName: "main", newRefName: "feat/x" },
        options,
      );

      const error = yield* driver
        .createWorktree({ cwd: main, path: null, refName: "main", newRefName: "fix/x" }, options)
        .pipe(Effect.flip);

      assert.include(error.detail, "already exists");
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
