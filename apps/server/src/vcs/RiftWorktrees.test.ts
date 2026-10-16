// @effect-diagnostics nodeBuiltinImport:off - fixtures drive git and the Rift CLI synchronously.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { GitCommandError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import { isRemovedRiftWorkspaceError } from "./RiftWorktrees.ts";

// Real-binary tests run only when pointed at Rift v0.0.13, always with a temporary registry.
const riftExecutable = process.env.T3CODE_TEST_RIFT_EXECUTABLE;
const windows = HostProcess.Platform.defaultValue() === "win32";
const encodeGitCommandError = Schema.encodeEffect(Schema.fromJsonString(GitCommandError));

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-rift-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const run = (command: string, args: ReadonlyArray<string>, cwd: string, input?: string) =>
  NodeChildProcess.execFileSync(command, args, { cwd, encoding: "utf8", input }).trim();
const git = (cwd: string, ...args: ReadonlyArray<string>) => run("git", args, cwd);

const makeFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = NodeFS.realpathSync(yield* fileSystem.makeTempDirectoryScoped({ prefix: "rift-" }));
  const source = NodePath.join(root, "source");
  NodeFS.mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.name", "Rift test");
  git(source, "config", "user.email", "rift@example.test");
  NodeFS.writeFileSync(NodePath.join(source, "tracked.txt"), "base\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "base");
  const database = NodePath.join(root, "registry.sqlite");
  const rpc = (request: Record<string, unknown>) =>
    JSON.parse(run(riftExecutable!, ["rpc"], root, JSON.stringify({ database, ...request })));
  const driver = yield* makeGitVcsDriverCore({
    rift: { ...(riftExecutable ? { executable: riftExecutable } : {}), database },
  });
  return { root, source, worktrees: NodePath.join(root, "worktrees"), rpc, driver };
});

const createRift = (
  fixture: Effect.Success<typeof makeFixture>,
  input: { readonly refName: string; readonly newRefName?: string; readonly name: string },
) =>
  fixture.driver.createWorktree(
    {
      cwd: fixture.source,
      refName: input.refName,
      ...(input.newRefName === undefined ? {} : { newRefName: input.newRefName }),
      baseRefName: "main",
      path: NodePath.join(fixture.worktrees, input.name),
    },
    { backend: "rift" },
  );

it.layer(layer)("Rift worktrees", (it) => {
  it.effect.skipIf(riftExecutable === undefined || windows)(
    "initializes automatically and starts clean without changing the project's checkout",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const { source } = fixture;
        const base = git(source, "rev-parse", "HEAD");
        NodeFS.writeFileSync(NodePath.join(source, "tracked.txt"), "next\n");
        git(source, "commit", "-qam", "next");
        const main = git(source, "rev-parse", "main");
        git(source, "worktree", "add", "-q", NodePath.join(fixture.root, "linked"), "-b", "linked");
        NodeFS.writeFileSync(NodePath.join(source, "tracked.txt"), "dirty\n");
        NodeFS.writeFileSync(NodePath.join(source, "staged.txt"), "staged\n");
        git(source, "add", "staged.txt");
        NodeFS.writeFileSync(NodePath.join(source, "untracked.txt"), "untracked\n");
        const [created, other] = yield* Effect.all(
          [
            createRift(fixture, { refName: base, newRefName: "t3/clean", name: "clean" }),
            createRift(fixture, { refName: base, newRefName: "t3/other", name: "other" }),
          ],
          { concurrency: 2 },
        );
        const copy = created.worktree.path;
        assert.deepEqual(fixture.rpc({ command: "list", of: source }).value.sort(), [
          copy,
          other.worktree.path,
        ]);
        assert.deepEqual(fixture.rpc({ command: "ancestors", of: copy }).value, [source]);
        assert.deepEqual(fixture.rpc({ command: "ancestors", of: other.worktree.path }).value, [
          source,
        ]);

        assert.deepEqual(created, {
          worktree: { path: NodePath.join(fixture.worktrees, "clean"), refName: "t3/clean" },
          createdSourceBranch: null,
        });
        assert.equal(git(copy, "rev-parse", "HEAD"), base);
        assert.equal(git(copy, "rev-parse", "main"), main);
        assert.equal(git(other.worktree.path, "rev-parse", "main"), main);
        assert.equal(git(copy, "diff", "--name-only", "main", "HEAD"), "tracked.txt");
        assert.equal(git(copy, "branch", "--show-current"), "t3/clean");
        assert.equal(git(copy, "status", "--porcelain", "--untracked-files=all"), "");
        assert.equal(NodeFS.readFileSync(NodePath.join(copy, "tracked.txt"), "utf8"), "base\n");
        assert.equal(git(copy, "config", "branch.t3/clean.gh-merge-base"), "main");
        assert.isFalse(NodeFS.existsSync(NodePath.join(copy, ".git", "worktrees")));

        assert.equal(git(source, "branch", "--show-current"), "main");
        assert.equal(git(source, "rev-parse", "main"), main);
        assert.equal(git(source, "branch", "--list", "t3/clean"), "");
        assert.equal(git(source, "diff", "--cached", "--name-only"), "staged.txt");
        assert.equal(NodeFS.readFileSync(NodePath.join(source, "tracked.txt"), "utf8"), "dirty\n");
        assert.isTrue(NodeFS.existsSync(NodePath.join(source, "untracked.txt")));
        assert.include(git(source, "worktree", "list"), NodePath.join(fixture.root, "linked"));

        assert.include(yield* fixture.driver.listWorktreePaths(source), copy);
        const refs = yield* fixture.driver.listRefs({ cwd: source, query: "t3/clean" });
        assert.deepEqual(
          refs.refs.map((ref) => [ref.name, ref.worktreePath]),
          [["t3/clean", copy]],
        );
        git(copy, "branch", "-m", "t3/renamed");
        const renamed = yield* fixture.driver.listRefs({ cwd: source, query: "t3/" });
        assert.deepEqual(renamed.refs.map((ref) => ref.name).sort(), ["t3/other", "t3/renamed"]);
      }),
  );

  it.effect.skipIf(riftExecutable === undefined || windows)(
    "removes only an owned leaf workspace and never recreates a removed one",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const { source, driver } = fixture;
        fixture.rpc({ command: "init", at: source });
        const created = yield* createRift(fixture, {
          refName: "main",
          newRefName: "t3/owned",
          name: "owned",
        });
        const copy = created.worktree.path;

        const root = yield* Effect.flip(
          driver.removeWorktree({ cwd: source, path: source, force: true }),
        );
        assert.equal(root._tag, "GitCommandError");
        assert.isTrue(NodeFS.existsSync(NodePath.join(source, ".rift")));

        const grandchild = fixture.rpc({
          command: "create",
          from: copy,
          name: "grandchild",
          into: fixture.worktrees,
          hooks: false,
        }).value;
        const withChild = yield* Effect.flip(
          driver.removeWorktree({ cwd: source, path: copy, force: true }),
        );
        assert.include(withChild.detail, "has its own Rift copies");
        assert.isTrue(NodeFS.existsSync(copy));
        fixture.rpc({ command: "remove", at: grandchild, hooks: false });

        NodeFS.writeFileSync(NodePath.join(copy, "notes.txt"), "local\n");
        const dirty = yield* Effect.flip(driver.removeWorktree({ cwd: source, path: copy }));
        assert.include(dirty.detail, "uncommitted changes");
        git(copy, "add", ".");
        git(copy, "commit", "-qm", "only here");
        const localCommits = yield* Effect.flip(driver.removeWorktree({ cwd: source, path: copy }));
        assert.include(localCommits.detail, "commits that exist only there");
        assert.isTrue(NodeFS.existsSync(copy));

        const childCommit = git(copy, "rev-parse", "HEAD");
        git(source, "fetch", "--no-write-fetch-head", copy, "t3/owned");
        assert.equal(git(source, "cat-file", "-t", childCommit), "commit");
        assert.notInclude(git(source, "rev-list", "--all"), childCommit);
        const dangling = yield* Effect.result(driver.removeWorktree({ cwd: source, path: copy }));
        assert.equal(dangling._tag, "Failure");
        if (dangling._tag === "Failure")
          assert.include(dangling.failure.detail, "commits that exist only there");
        assert.isTrue(NodeFS.existsSync(copy));

        git(source, "update-ref", "refs/heads/retained-child", childCommit);
        NodeFS.writeFileSync(NodePath.join(copy, "notes.txt"), "checkpoint\n");
        git(copy, "commit", "-qam", "checkpoint only here");
        const checkpointCommit = git(copy, "rev-parse", "HEAD");
        git(copy, "update-ref", "refs/t3code/checkpoints/only-here", checkpointCommit);
        git(copy, "reset", "--hard", childCommit);
        const checkpoint = yield* Effect.flip(driver.removeWorktree({ cwd: source, path: copy }));
        assert.include(checkpoint.detail, "commits that exist only there");
        assert.isTrue(NodeFS.existsSync(copy));

        git(source, "fetch", "--no-write-fetch-head", copy, "refs/t3code/checkpoints/only-here");
        git(source, "update-ref", "refs/tags/retained-checkpoint", checkpointCommit);
        yield* driver.removeWorktree({ cwd: source, path: copy });
        assert.isFalse(NodeFS.existsSync(copy));
        yield* driver.removeWorktree({ cwd: source, path: copy, force: true });

        const recreated = yield* Effect.flip(
          driver.createWorktree(
            { cwd: source, refName: "t3/owned", path: copy },
            { backend: "git" },
          ),
        );
        assert.isTrue(isRemovedRiftWorkspaceError(recreated));
        assert.isFalse(NodeFS.existsSync(copy));

        const defaultPathInput = {
          cwd: source,
          refName: "main",
          newRefName: "t3/default-path",
          path: null,
        };
        const defaultPath = yield* driver.createWorktree(defaultPathInput, {
          backend: "rift",
          worktreesDirectory: fixture.worktrees,
        });
        yield* driver.removeWorktree({ cwd: source, path: defaultPath.worktree.path, force: true });
        const reusedDefault = yield* Effect.result(
          driver.createWorktree(defaultPathInput, {
            backend: "git",
            worktreesDirectory: fixture.worktrees,
          }),
        );
        assert.equal(reusedDefault._tag, "Failure");
        if (reusedDefault._tag === "Failure")
          assert.isTrue(isRemovedRiftWorkspaceError(reusedDefault.failure));
        assert.isFalse(NodeFS.existsSync(defaultPath.worktree.path));
      }),
  );

  it.effect.skipIf(riftExecutable === undefined || windows)(
    "trashes its own copy when preparation fails or is interrupted after the claim",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        fixture.rpc({ command: "init", at: fixture.source });
        const claimed: Array<string> = [];

        const failed = yield* Effect.flip(
          fixture.driver.createWorktree(
            {
              cwd: fixture.source,
              refName: "main",
              newRefName: "bad..name",
              path: NodePath.join(fixture.worktrees, "failed"),
            },
            {
              backend: "rift",
              progress: { onWorktreeClaimed: (path) => Effect.sync(() => claimed.push(path)) },
            },
          ),
        );
        assert.equal(failed._tag, "GitCommandError");
        assert.deepEqual(claimed, [NodePath.join(fixture.worktrees, "failed")]);
        assert.isFalse(NodeFS.existsSync(claimed[0]!));

        const reachedClaim = yield* Deferred.make<void>();
        const creating = yield* fixture.driver
          .createWorktree(
            {
              cwd: fixture.source,
              refName: "main",
              newRefName: "t3/interrupted",
              path: NodePath.join(fixture.worktrees, "interrupted"),
            },
            {
              backend: "rift",
              progress: {
                onWorktreeClaimed: () =>
                  Deferred.succeed(reachedClaim, undefined).pipe(Effect.asVoid),
              },
            },
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(reachedClaim);
        yield* Fiber.interrupt(creating);
        assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.worktrees, "interrupted")));
        assert.deepEqual(fixture.rpc({ command: "list", of: fixture.source }).value, []);
      }),
  );

  it.effect.skipIf(riftExecutable === undefined || windows)(
    "preserves the original digest and receipt-storage failures",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const fileSystem = yield* FileSystem.FileSystem;
        const crypto = yield* Crypto.Crypto;
        const cause = yield* Effect.flip(
          fileSystem.readFileString(NodePath.join(fixture.root, "missing")),
        );
        for (const stage of ["digest", "receipt"] as const) {
          const driver = yield* makeGitVcsDriverCore({
            rift: {
              ...(riftExecutable ? { executable: riftExecutable } : {}),
              database: NodePath.join(fixture.root, "registry.sqlite"),
            },
          }).pipe(
            Effect.provideService(Crypto.Crypto, {
              ...crypto,
              digest: stage === "digest" ? () => Effect.fail(cause) : crypto.digest,
            }),
            Effect.provideService(FileSystem.FileSystem, {
              ...fileSystem,
              rename: stage === "receipt" ? () => Effect.fail(cause) : fileSystem.rename,
            }),
          );
          const error = yield* Effect.flip(
            driver.createWorktree(
              {
                cwd: fixture.source,
                refName: "main",
                newRefName: `t3/${stage}`,
                path: NodePath.join(fixture.worktrees, stage),
              },
              { backend: "rift" },
            ),
          );
          assert.equal(
            error.operation,
            stage === "digest" ? "RiftWorktrees.receipt" : "RiftWorktrees.writeReceipt",
          );
          assert.strictEqual(error.cause, cause);
          assert.notInclude(error.detail, "missing");
        }
      }),
  );

  it.effect.skipIf(windows)("refuses project layouts whose copies could write back", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const linked = NodePath.join(fixture.root, "linked");
      git(fixture.source, "worktree", "add", "-q", linked, "-b", "linked");
      const fromLinked = yield* Effect.flip(
        fixture.driver.createWorktree(
          { cwd: linked, refName: "main", newRefName: "t3/a", path: null },
          { backend: "rift" },
        ),
      );
      assert.include(fromLinked.detail, "main checkout");
      const busyBranch = yield* Effect.flip(createRift(fixture, { refName: "main", name: "busy" }));
      assert.equal(busyBranch.reason, "branch_checked_out_in_worktree");

      NodeFS.writeFileSync(NodePath.join(fixture.source, ".gitmodules"), "");
      const withSubmodules = yield* Effect.flip(
        createRift(fixture, { refName: "main", newRefName: "t3/b", name: "b" }),
      );
      assert.include(withSubmodules.detail, "submodules");
      assert.isFalse(NodeFS.existsSync(fixture.worktrees));

      NodeFS.unlinkSync(NodePath.join(fixture.source, ".gitmodules"));
      git(
        fixture.source,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        fixture.source,
        "vendor/module",
      );
      git(fixture.source, "commit", "-qm", "add submodule");
      git(fixture.source, "config", "submodule.recurse", "true");
      NodeFS.unlinkSync(NodePath.join(fixture.source, ".gitmodules"));
      assert.isTrue(NodeFS.existsSync(NodePath.join(fixture.source, ".git/modules/vendor/module")));
      const withModuleMetadata = yield* Effect.flip(
        createRift(fixture, { refName: "main", newRefName: "t3/c", name: "c" }),
      );
      assert.include(withModuleMetadata.detail, "submodules");
      assert.isFalse(NodeFS.existsSync(fixture.worktrees));
    }),
  );

  it.effect.skipIf(windows)("reports Rift failures with fixed guidance, never raw output", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const fake = (name: string, stdout: string, initStdout = '{"status":"ok","value":null}') => {
        const file = NodePath.join(fixture.root, name);
        NodeFS.writeFileSync(
          file,
          `#!/bin/sh
request=$(cat)
case "$request" in
  *'"command":"init"'*) printf '%s' '${initStdout}' ;;
  *) printf '%s' '${stdout}' ;;
esac
`,
          { mode: 0o755 },
        );
        return file;
      };
      const errorFrom = (executable: string) =>
        Effect.gen(function* () {
          const driver = yield* makeGitVcsDriverCore({ rift: { executable } });
          const error = yield* Effect.flip(
            driver.createWorktree(
              {
                cwd: fixture.source,
                refName: "main",
                newRefName: "t3/fake",
                path: NodePath.join(fixture.worktrees, "fake"),
              },
              { backend: "rift" },
            ),
          );
          return error;
        });

      assert.equal(
        (yield* errorFrom(
          fake(
            "uninitialized",
            '{"status":"error","error":{"code":"workspace_not_initialized","message":"secret-path"}}',
          ),
        )).detail,
        "Rift could not initialize this project. Try creating the worktree again.",
      );
      const initError = yield* errorFrom(
        fake(
          "init-failure",
          '{"status":"ok","value":"/private/secret-cli-output"}',
          '{"status":"error","error":{"code":"database","message":"secret-path"}}',
        ),
      );
      assert.equal(initError.operation, "GitVcsDriver.createWorktree.rift.init");
      assert.equal(initError.detail, "Rift could not open its registry on this machine.");
      assert.equal(
        (yield* errorFrom(
          fake("unknown", '{"status":"error","error":{"code":"Some Thing!","message":"secret"}}'),
        )).detail,
        "Rift create failed (unknown).",
      );
      for (const executable of [
        fake("garbage", "secret garbage"),
        fake("wrong-shape", '{"status":"ok","value":42}'),
      ]) {
        const error = yield* errorFrom(executable);
        assert.equal(
          error.detail,
          "Rift returned an unexpected response. T3 Code supports Rift v0.0.13.",
        );
        assert.deepInclude(error.cause, { _tag: "SchemaError" });
      }
      const missing = yield* errorFrom(NodePath.join(fixture.root, "missing-rift"));
      assert.include(missing.detail, "Rift is not installed");
      assert.deepInclude(missing.cause, { _tag: "ProcessSpawnError" });
      const unexpectedPath = yield* errorFrom(
        fake("wrong-path", '{"status":"ok","value":"/private/secret-cli-output"}'),
      );
      assert.equal(unexpectedPath._tag, "GitCommandError");
      assert.equal(unexpectedPath.operation, "GitVcsDriver.createWorktree.rift");
      assert.equal(
        unexpectedPath.detail,
        `Rift returned an unexpected workspace path. Check ${NodePath.join(fixture.worktrees, "fake")} and Rift's workspace list before trying again; no workspace was removed.`,
      );
      const wireError = yield* encodeGitCommandError(unexpectedPath);
      assert.notInclude(wireError, "secret-cli-output");
      assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.worktrees, "fake")));
    }),
  );
});
