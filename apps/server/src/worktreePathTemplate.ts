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

/** Git stores refs as paths, so `t3` blocks `t3/x`, and `t3/x/y` blocks `t3/x`. */
export const branchConflicts = (candidate: string, branches: ReadonlyArray<string>) =>
  branches.some(
    (branch) =>
      branch === candidate ||
      branch.startsWith(`${candidate}/`) ||
      candidate.startsWith(`${branch}/`),
  );

// Branches (per Git common dir) and folders picked but not yet created, so two
// launches in this process do not pick clashing names. A claim that leaks
// after a failure only gives a later launch with that name a suffix.
const claimedBranches = new Map<string, Set<string>>();
const claimedPaths = new Set<string>();
// Git common dirs whose template fallback to the default location is logged.
const defaultLocationLogged = new Set<string>();

const REFS_HEADS = "refs/heads/";

/**
 * The folder and branch for a new worktree. A template path inside the
 * checkout, as `{repoDir}/{branchLeaf}` gives in a normal clone, uses
 * `defaultPath` instead, so one template fits both layouts. With `pickFreeName`, a taken
 * branch or folder gets a `-1`, `-2` suffix on the branch, as `renameBranch`
 * does, so that the folder still follows the branch. When a branch blocks
 * the namespace, the name is flattened, as `t3/x` becomes `t3-x`. Run
 * `release` after `git worktree add` ends.
 */
export const placeTemplateWorktree = Effect.fn("placeTemplateWorktree")(function* (input: {
  readonly cwd: string;
  readonly template: string;
  readonly worktreesDirectory: string;
  readonly gitCommonDir: string;
  readonly checkoutRoot: string;
  readonly branch: string;
  /** Where the worktree goes without a template. */
  readonly defaultPath: (branch: string) => string;
  readonly pickFreeName: boolean;
  /** `git for-each-ref --format=%(refname) refs/heads/` output. Full names stay unambiguous next to tags. */
  readonly listBranchRefs: Effect.Effect<string, GitCommandError>;
  readonly pathExists: (path: string) => Effect.Effect<boolean>;
  readonly path: Path.Path;
  readonly home: string;
}) {
  const invalid = validateWorktreePathTemplate(input.template);
  if (invalid !== null) return yield* templateError(input.cwd, invalid);
  const repoDir = input.path.dirname(input.gitCommonDir);
  // A normal clone keeps its Git dir in `<checkout>/.git`. From a linked
  // worktree of it, that main checkout is not `checkoutRoot`.
  const checkouts = [input.checkoutRoot, input.gitCommonDir];
  if (input.path.basename(input.gitCommonDir) === ".git") checkouts.push(repoDir);
  let usedDefault = false;
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
    const insideCheckout = checkouts.some((parent) => {
      const relative = input.path.relative(parent, resolved);
      return !relative.startsWith("..") && !input.path.isAbsolute(relative);
    });
    if (!insideCheckout) return resolved;
    usedDefault = true;
    return input.defaultPath(branch);
  };
  const first = resolve(input.branch);
  if (typeof first !== "string") return yield* first;
  if (usedDefault && !defaultLocationLogged.has(input.gitCommonDir)) {
    defaultLocationLogged.add(input.gitCommonDir);
    yield* Effect.logInfo(
      `The worktree path template puts worktrees inside the checkout of ${repoDir}, so its worktrees use the default location.`,
    );
  }

  if (!input.pickFreeName) {
    const path = first;
    // A typed or pull request branch keeps its name, so a taken folder is an error.
    if (yield* input.pathExists(path))
      return yield* templateError(
        input.cwd,
        `The folder "${path}" for branch "${input.branch}" already exists. Remove it, or use {branch} instead of {branchLeaf}.`,
      );
    return { branch: input.branch, path, release: Effect.void };
  }
  const listBranches = input.listBranchRefs.pipe(
    Effect.map((refs) =>
      refs
        .split("\n")
        .filter((line) => line.startsWith(REFS_HEADS))
        .map((line) => line.slice(REFS_HEADS.length)),
    ),
  );
  let branches = yield* listBranches;
  let claimed = claimedBranches.get(input.gitCommonDir);
  if (claimed === undefined) {
    claimed = new Set();
    claimedBranches.set(input.gitCommonDir, claimed);
  }
  const claimedHere = claimed;
  const flattened = input.branch.replaceAll("/", "-");
  const bases = flattened === input.branch ? [input.branch] : [input.branch, flattened];
  for (const base of bases) {
    for (let suffix = 0; suffix <= MAX_NAME_SUFFIX; suffix += 1) {
      const branch = suffix === 0 ? base : `${base}-${suffix}`;
      const path = resolve(branch);
      if (typeof path !== "string") return yield* path;
      if (branchConflicts(branch, branches) || (yield* input.pathExists(path))) continue;
      // Checked and claimed in one synchronous step, so no other fiber runs between.
      if (claimedPaths.has(path) || branchConflicts(branch, [...claimedHere])) continue;
      claimedHere.add(branch);
      claimedPaths.add(path);
      const release = Effect.sync(() => {
        claimedHere.delete(branch);
        claimedPaths.delete(path);
      });
      // Check Git again after the claim. A launch that released its claim
      // before this point already created its branch and folder.
      branches = yield* listBranches;
      if (branchConflicts(branch, branches) || (yield* input.pathExists(path))) {
        yield* release;
        continue;
      }
      return { branch, path, release };
    }
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
