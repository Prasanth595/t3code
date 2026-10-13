import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  expandWorktreePathTemplate,
  validateWorktreePathTemplate,
  worktreePathBranchVariables,
} from "@t3tools/shared/worktreePathTemplate";

/** Fork: the `worktreePathTemplate` setting. See docs/fork.md. */

const MAX_NAME_SUFFIX = 100;

const templateError = (cwd: string, detail: string) =>
  new GitCommandError({
    operation: "GitVcsDriver.createWorktree",
    command: "git worktree add",
    cwd,
    detail: `${detail} Change the worktree path template in Settings → Storage.`,
  });

/**
 * The folder and branch for a new worktree. With `pickFreeName`, a taken
 * branch or folder gets a `-1`, `-2` suffix on the branch, as
 * `renameBranch` does, so that the folder still follows the branch.
 */
export const placeTemplateWorktree = Effect.fn("placeTemplateWorktree")(function* (input: {
  readonly cwd: string;
  readonly template: string;
  readonly worktreesDirectory: string;
  readonly gitCommonDir: string;
  readonly checkoutRoot: string;
  readonly branch: string;
  readonly pickFreeName: boolean;
  readonly isTaken: (candidate: {
    readonly branch: string;
    readonly path: string;
  }) => Effect.Effect<boolean, GitCommandError>;
  readonly path: Path.Path;
  readonly home: string;
}) {
  const invalid = validateWorktreePathTemplate(input.template);
  if (invalid !== null) return yield* templateError(input.cwd, invalid);
  const repoDir = input.path.dirname(input.gitCommonDir);
  const resolve = (branch: string): string | GitCommandError => {
    const expanded = expandHomePath(
      expandWorktreePathTemplate(input.template, {
        worktrees: input.worktreesDirectory,
        repoDir,
        repo: input.path.basename(repoDir),
        ...worktreePathBranchVariables(branch),
      }),
      input.home,
    );
    if (!input.path.isAbsolute(expanded))
      return templateError(input.cwd, `"${expanded}" is not an absolute path.`);
    const resolved = input.path.resolve(expanded);
    // A normal clone with {repoDir}/{branchLeaf} would nest the worktree in the checkout.
    for (const parent of [input.checkoutRoot, input.gitCommonDir]) {
      const relative = input.path.relative(parent, resolved);
      if (!relative.startsWith("..") && !input.path.isAbsolute(relative))
        return templateError(
          input.cwd,
          `"${resolved}" is inside "${parent}". For a normal clone, use {worktrees} or {repoDir}/.. in the template.`,
        );
    }
    return resolved;
  };

  const first = resolve(input.branch);
  if (typeof first !== "string") return yield* first;
  if (!input.pickFreeName || !(yield* input.isTaken({ branch: input.branch, path: first })))
    return { branch: input.branch, path: first };
  for (let suffix = 1; suffix <= MAX_NAME_SUFFIX; suffix += 1) {
    const branch = `${input.branch}-${suffix}`;
    const path = resolve(branch);
    if (typeof path !== "string") return yield* path;
    if (!(yield* input.isTaken({ branch, path }))) return { branch, path };
  }
  return yield* templateError(
    input.cwd,
    `Could not find a free branch name and folder for "${input.branch}".`,
  );
});

// Lives in the worktree's own folder in the Git common dir, so `git worktree
// remove` and `git worktree prune` delete it with the worktree.
const CREATED_MARKER = "t3-created";

/** The `gitdir:` folder that a linked worktree's `.git` file points to. */
const adminDirectory = (fs: FileSystem.FileSystem, path: Path.Path, worktreePath: string) =>
  fs.readFileString(path.join(worktreePath, ".git")).pipe(
    Effect.map((contents) => {
      const line = contents.trim();
      return line.startsWith("gitdir:")
        ? path.resolve(worktreePath, line.slice("gitdir:".length).trim())
        : null;
    }),
  );

/**
 * Marks a worktree that T3 created from the template. Cleanup and review
 * diffs trust the mark, because such a worktree can be outside the managed
 * worktree folders.
 */
export const markT3CreatedWorktree = Effect.fn("markT3CreatedWorktree")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
  worktreePath: string,
) {
  const markError = (detail: string) =>
    new GitCommandError({
      operation: "GitVcsDriver.createWorktree",
      command: "git worktree add",
      cwd,
      detail: `Could not mark ${worktreePath} as created by T3: ${detail}`,
    });
  const directory = yield* adminDirectory(fs, path, worktreePath).pipe(
    Effect.mapError((cause) => markError(cause.message)),
  );
  if (directory === null) return yield* markError("its .git file has no gitdir line.");
  yield* fs
    .writeFileString(path.join(directory, CREATED_MARKER), "")
    .pipe(Effect.mapError((cause) => markError(cause.message)));
});

export const isT3CreatedWorktree = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  worktreePath: string,
) =>
  adminDirectory(fs, path, worktreePath).pipe(
    Effect.flatMap((directory) =>
      directory === null ? Effect.succeed(false) : fs.exists(path.join(directory, CREATED_MARKER)),
    ),
    Effect.orElseSucceed(() => false),
  );
