import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as ProcessRunner from "../processRunner.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn("makeTempDir")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-paths-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(layerTest)("WorkspacePathsLive", (it) => {
  describe("normalizeWorkspaceRoot", () => {
    it.effect("resolves an existing directory", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();

        const resolved = yield* workspacePaths.normalizeWorkspaceRoot(cwd);

        expect(resolved).toBe(cwd);
      }),
    );

    it.effect("rejects missing directories", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;

        const error = yield* workspacePaths
          .normalizeWorkspaceRoot(path.join(cwd, "missing"))
          .pipe(Effect.flip);

        expect(error.message).toContain("Workspace root does not exist:");
      }),
    );

    it.effect("creates missing directories when createIfMissing is enabled", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;
        const missingPath = path.join(cwd, "nested", "new-project");

        const resolved = yield* workspacePaths.normalizeWorkspaceRoot(missingPath, {
          createIfMissing: true,
        });
        const stat = yield* fileSystem.stat(resolved);

        expect(resolved).toBe(missingPath);
        expect(stat.type).toBe("Directory");
      }),
    );

    it.effect("rejects file paths", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;
        const filePath = path.join(cwd, "README.md");
        yield* writeTextFile(cwd, "README.md", "# hi\n");

        const error = yield* workspacePaths.normalizeWorkspaceRoot(filePath).pipe(Effect.flip);

        expect(error.message).toContain("Workspace root is not a directory:");
      }),
    );

    it.effect("preserves non-NotFound stat failures while validating the root", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspacePaths = yield* WorkspacePaths.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            stat: (path) =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "stat",
                  pathOrDescriptor: String(path),
                  description: "Test PermissionDenied stat failure.",
                }),
              ),
          }),
        );
        const path = yield* Path.Path;
        const workspaceRoot = " ./permission-denied ";
        const normalizedWorkspaceRoot = path.resolve(workspaceRoot.trim());

        const error = yield* workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspaceRootStatFailedError);
        expect(error).toMatchObject({
          workspaceRoot,
          normalizedWorkspaceRoot,
          phase: "validate-existing",
        });
      }),
    );

    it.effect("preserves stat failures while verifying a newly created root", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        let statCalls = 0;
        const workspacePaths = yield* WorkspacePaths.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            stat: (path) => {
              statCalls += 1;
              const reason = statCalls === 1 ? "NotFound" : "PermissionDenied";
              return Effect.fail(
                PlatformError.systemError({
                  _tag: reason,
                  module: "FileSystem",
                  method: "stat",
                  pathOrDescriptor: String(path),
                  description: `Test ${reason} stat failure.`,
                }),
              );
            },
            makeDirectory: () => Effect.void,
          }),
        );
        const path = yield* Path.Path;
        const workspaceRoot = " ./created-then-unreadable ";
        const normalizedWorkspaceRoot = path.resolve(workspaceRoot.trim());

        const error = yield* workspacePaths
          .normalizeWorkspaceRoot(workspaceRoot, { createIfMissing: true })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspaceRootStatFailedError);
        expect(error).toMatchObject({
          workspaceRoot,
          normalizedWorkspaceRoot,
          phase: "verify-created",
        });
      }),
    );
  });

  describe("resolveRelativePathWithinRoot", () => {
    it.effect("resolves relative paths inside the workspace root", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;

        const resolved = yield* workspacePaths.resolveRelativePathWithinRoot({
          workspaceRoot: cwd,
          relativePath: "plans/effect-rpc.md",
        });

        expect(resolved).toEqual({
          absolutePath: path.join(cwd, "plans/effect-rpc.md"),
          relativePath: "plans/effect-rpc.md",
        });
      }),
    );

    it.effect("rejects paths that escape the workspace root", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();

        const error = yield* workspacePaths
          .resolveRelativePathWithinRoot({
            workspaceRoot: cwd,
            relativePath: "../escape.md",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );
  });
});

const pathsWithPrefix = (prefix: string) =>
  WorkspacePaths.make.pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: () =>
        Effect.succeed({
          stdout: `${prefix}\n`,
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        }),
    }),
  );

it.layer(layerTest)("project cwd in a worktree", (it) => {
  it.effect("keeps a Scratch thread's independent non-Git folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeTempDir();
      const threadFolder = path.join(root, "thread-1");
      yield* fs.makeDirectory(threadFolder);
      const paths = yield* WorkspacePaths.WorkspacePaths;
      expect(yield* paths.resolveProjectCwd({ cwd: root, worktreePath: threadFolder })).toBe(
        threadFolder,
      );
    }),
  );

  for (const directory of ["ios", "nested/ios", "ios\\release", " ios "]) {
    it.effect(`uses the existing project directory ${JSON.stringify(directory)}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTempDir().pipe(Effect.flatMap((value) => fs.realPath(value)));
        const candidate = path.join(root, directory);
        yield* fs.makeDirectory(candidate, { recursive: true });
        const paths = yield* pathsWithPrefix(`${directory}/`);
        expect(yield* paths.resolveProjectCwd({ cwd: "/repo/ios", worktreePath: root })).toBe(
          candidate,
        );
      }),
    );
  }

  for (const state of ["missing", "file", "file-parent", "escaping-symlink"] as const) {
    it.effect.skipIf(state === "escaping-symlink" && !symlinksSupported)(
      `falls back to the checkout root for ${state}`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const base = yield* makeTempDir();
          const root = path.join(base, "worktree");
          yield* fs.makeDirectory(root);
          const candidate = path.join(root, "ios");
          if (state === "file" || state === "file-parent")
            yield* fs.writeFileString(candidate, "not a directory");
          if (state === "escaping-symlink") {
            const outside = path.join(base, "worktree-other");
            yield* fs.makeDirectory(outside);
            yield* fs.symlink(outside, candidate);
          }
          const paths = yield* pathsWithPrefix(state === "file-parent" ? "ios/nested/" : "ios/");
          expect(yield* paths.resolveProjectCwd({ cwd: "/repo/ios", worktreePath: root })).toBe(
            root,
          );
        }),
    );
  }

  it.effect.skipIf(!symlinksSupported)("keeps a contained symlink inside the checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeTempDir().pipe(Effect.flatMap((value) => fs.realPath(value)));
      const actual = path.join(root, "packages", "ios");
      yield* fs.makeDirectory(actual, { recursive: true });
      yield* fs.symlink(actual, path.join(root, "ios"));
      const paths = yield* pathsWithPrefix("ios/");
      expect(yield* paths.resolveProjectCwd({ cwd: "/repo/ios", worktreePath: root })).toBe(actual);
    }),
  );

  for (const prefix of ["../outside/", "ios/../../outside/", "/absolute/escape/"]) {
    it.effect(`rejects an escaping prefix ${prefix}`, () =>
      Effect.gen(function* () {
        const paths = yield* pathsWithPrefix(prefix);
        expect(
          yield* paths.resolveProjectCwd({ cwd: "/repo/ios", worktreePath: "/worktree" }),
        ).toBe("/worktree");
      }),
    );
  }

  it.effect("keeps local and repository-root project cwd unchanged", () =>
    Effect.gen(function* () {
      const paths = yield* pathsWithPrefix("");
      expect(yield* paths.resolveProjectCwd({ cwd: "/repo/ios" })).toBe("/repo/ios");
      expect(yield* paths.resolveProjectCwd({ cwd: "/repo", worktreePath: "/worktree" })).toBe(
        "/worktree",
      );
    }),
  );

  for (const operation of ["stat", "realPath"] as const) {
    it.effect(`preserves permission errors from ${operation}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTempDir();
        yield* fs.makeDirectory(path.join(root, "ios"));
        const cause = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: operation,
          pathOrDescriptor: root,
        });
        const paths = yield* pathsWithPrefix("ios/").pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            [operation]: () => Effect.fail(cause),
          }),
        );
        const error = yield* paths
          .resolveProjectCwd({ cwd: "/repo/ios", worktreePath: root })
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(WorkspacePaths.WorkspaceProjectCwdError);
        expect(error.cause).toBe(cause);
      }),
    );
  }

  for (const root of ["C:\\worktrees\\feature", "\\\\host\\share\\feature"]) {
    it.effect(`uses native Windows semantics for ${root}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.stat(yield* makeTempDir());
        const paths = yield* pathsWithPrefix("packages/ios/").pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            stat: () => Effect.succeed(directory),
            realPath: (value) => Effect.succeed(value),
          }),
          Effect.provide(NodePath.layerWin32),
        );
        expect(
          yield* paths.resolveProjectCwd({ cwd: "C:\\repo\\packages\\ios", worktreePath: root }),
        ).toBe(`${root}\\packages\\ios`);
      }),
    );
  }

  it.effect("rejects a Windows symlink resolved onto a different drive", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.stat(yield* makeTempDir());
      const root = "C:\\worktrees\\feature";
      const paths = yield* pathsWithPrefix("ios/").pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stat: () => Effect.succeed(directory),
          realPath: (value) => Effect.succeed(value === root ? root : "D:\\outside\\ios"),
        }),
        Effect.provide(NodePath.layerWin32),
      );
      expect(yield* paths.resolveProjectCwd({ cwd: "C:\\repo\\ios", worktreePath: root })).toBe(
        root,
      );
    }),
  );
});
