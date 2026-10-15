/**
 * WorkspacePaths - Effect service contract for workspace path handling.
 *
 * Owns normalization and validation of workspace roots plus safe resolution of
 * workspace-root-relative paths.
 *
 * @module WorkspacePaths
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";

export class WorkspaceProjectCwdError extends Schema.TaggedError<WorkspaceProjectCwdError>()(
  "WorkspaceProjectCwdError",
  {
    cwd: Schema.String,
    worktreePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not resolve the project working directory in worktree '${this.worktreePath}'.`;
  }
}

export class WorkspaceRootNotExistsError extends Schema.TaggedError<WorkspaceRootNotExistsError>()(
  "WorkspaceRootNotExistsError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace root does not exist: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspaceRootCreateFailedError extends Schema.TaggedError<WorkspaceRootCreateFailedError>()(
  "WorkspaceRootCreateFailedError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create workspace root: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspaceRootStatFailedError extends Schema.TaggedError<WorkspaceRootStatFailedError>()(
  "WorkspaceRootStatFailedError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
    phase: Schema.Literals(["validate-existing", "verify-created"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to stat workspace root '${this.normalizedWorkspaceRoot}' during '${this.phase}'.`;
  }
}

export class WorkspaceRootNotDirectoryError extends Schema.TaggedError<WorkspaceRootNotDirectoryError>()(
  "WorkspaceRootNotDirectoryError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace root is not a directory: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspacePathOutsideRootError extends Schema.TaggedError<WorkspacePathOutsideRootError>()(
  "WorkspacePathOutsideRootError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file path must be relative to the project root: ${this.relativePath}`;
  }
}

export const WorkspacePathsError = Schema.Union([
  WorkspaceRootNotExistsError,
  WorkspaceRootCreateFailedError,
  WorkspaceRootStatFailedError,
  WorkspaceRootNotDirectoryError,
  WorkspacePathOutsideRootError,
]);
export type WorkspacePathsError = typeof WorkspacePathsError.Type;

/** Service tag for workspace path normalization and resolution. */
export class WorkspacePaths extends Context.Service<
  WorkspacePaths,
  {
    /** Resolve the project's directory inside a checkout without changing the checkout root. */
    readonly resolveProjectCwd: (input: {
      readonly cwd: string;
      readonly worktreePath?: string | null | undefined;
    }) => Effect.Effect<string, WorkspaceProjectCwdError>;
    /** Normalize a user-provided workspace root and verify it exists as a directory. */
    readonly normalizeWorkspaceRoot: (
      workspaceRoot: string,
      options?: { readonly createIfMissing?: boolean },
    ) => Effect.Effect<
      string,
      | WorkspaceRootNotExistsError
      | WorkspaceRootCreateFailedError
      | WorkspaceRootStatFailedError
      | WorkspaceRootNotDirectoryError
    >;
    /**
     * Resolve a relative path within a validated workspace root.
     *
     * Rejects absolute paths and traversal attempts outside the workspace root.
     */
    readonly resolveRelativePathWithinRoot: (input: {
      workspaceRoot: string;
      relativePath: string;
    }) => Effect.Effect<
      { absolutePath: string; relativePath: string },
      WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspacePaths") {}

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const isWithinRoot = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };

  const resolveProjectCwd: WorkspacePaths["Service"]["resolveProjectCwd"] = Effect.fn(
    "WorkspacePaths.resolveProjectCwd",
  )(function* (input) {
    if (!input.worktreePath) return input.cwd;
    const worktreePath = input.worktreePath;
    return yield* Effect.gen(function* () {
      // Git knows the subdirectory even without a remote and through a symlinked checkout.
      const prefix = yield* processRunner.run({
        command: "git",
        args: ["-C", input.cwd, "rev-parse", "--show-prefix"],
        env: { LC_ALL: "C" },
        timeout: "5 seconds",
      });
      // Scratch threads also use worktreePath for their independent, non-Git folder.
      if (prefix.code !== 0) {
        if (prefix.stderr.toLowerCase().includes("not a git repository")) return worktreePath;
        return yield* Effect.fail({ exitCode: prefix.code, stderr: prefix.stderr });
      }
      const relative = prefix.stdout.replace(/\r?\n$/, "");
      if (relative === "") return worktreePath;
      const candidate = path.resolve(worktreePath, relative);
      if (!isWithinRoot(worktreePath, candidate)) return worktreePath;

      return yield* Effect.gen(function* () {
        if ((yield* fileSystem.stat(candidate)).type !== "Directory") return worktreePath;
        const root = yield* fileSystem.realPath(worktreePath);
        const resolved = yield* fileSystem.realPath(candidate);
        return isWithinRoot(root, resolved) ? resolved : worktreePath;
      }).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound" || error.reason._tag === "BadResource",
          () => Effect.succeed(worktreePath),
        ),
      );
    }).pipe(
      Effect.mapError(
        (cause) => new WorkspaceProjectCwdError({ cwd: input.cwd, worktreePath, cause }),
      ),
    );
  });

  const statWorkspaceRoot = Effect.fn("WorkspacePaths.statWorkspaceRoot")(function* (
    workspaceRoot: string,
    normalizedWorkspaceRoot: string,
    phase: WorkspaceRootStatFailedError["phase"],
  ) {
    return yield* fileSystem.stat(normalizedWorkspaceRoot).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(null)
            : Effect.fail(
                new WorkspaceRootStatFailedError({
                  workspaceRoot,
                  normalizedWorkspaceRoot,
                  phase,
                  cause,
                }),
              ),
        onSuccess: Effect.succeed,
      }),
    );
  });

  const normalizeWorkspaceRoot: WorkspacePaths["Service"]["normalizeWorkspaceRoot"] = Effect.fn(
    "WorkspacePaths.normalizeWorkspaceRoot",
  )(function* (workspaceRoot, options) {
    const normalizedWorkspaceRoot = path.resolve(
      expandHomePath(workspaceRoot.trim(), yield* HostProcess.HomeDirectory),
    );
    let workspaceStat = yield* statWorkspaceRoot(
      workspaceRoot,
      normalizedWorkspaceRoot,
      "validate-existing",
    );
    if (!workspaceStat && options?.createIfMissing) {
      yield* fileSystem.makeDirectory(normalizedWorkspaceRoot, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceRootCreateFailedError({
              workspaceRoot,
              normalizedWorkspaceRoot,
              cause,
            }),
        ),
      );
      workspaceStat = yield* statWorkspaceRoot(
        workspaceRoot,
        normalizedWorkspaceRoot,
        "verify-created",
      );
    }
    if (!workspaceStat) {
      return yield* new WorkspaceRootNotExistsError({
        workspaceRoot,
        normalizedWorkspaceRoot,
      });
    }
    if (workspaceStat.type !== "Directory") {
      return yield* new WorkspaceRootNotDirectoryError({
        workspaceRoot,
        normalizedWorkspaceRoot,
      });
    }
    return normalizedWorkspaceRoot;
  });

  const resolveRelativePathWithinRoot: WorkspacePaths["Service"]["resolveRelativePathWithinRoot"] =
    Effect.fn("WorkspacePaths.resolveRelativePathWithinRoot")(function* (input) {
      const normalizedInputPath = input.relativePath.trim();
      if (path.isAbsolute(normalizedInputPath)) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      const absolutePath = path.resolve(input.workspaceRoot, normalizedInputPath);
      const relativeToRoot = toPosixRelativePath(path.relative(input.workspaceRoot, absolutePath));
      if (
        relativeToRoot.length === 0 ||
        relativeToRoot === "." ||
        relativeToRoot.startsWith("../") ||
        relativeToRoot === ".." ||
        path.isAbsolute(relativeToRoot)
      ) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      return {
        absolutePath,
        relativePath: relativeToRoot,
      };
    });

  return WorkspacePaths.of({
    resolveProjectCwd,
    normalizeWorkspaceRoot,
    resolveRelativePathWithinRoot,
  });
});

export const layer = Layer.effect(WorkspacePaths, make).pipe(Layer.provide(ProcessRunner.layer));
