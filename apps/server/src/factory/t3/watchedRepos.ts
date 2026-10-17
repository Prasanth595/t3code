import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import {
  factoryOptIn,
  PROJECT_CONFIG_PATH,
  type WatchedListing,
  type WatchedProject,
} from "../config.ts";

/**
 * The repos the factory watches, read from this environment's T3 projects: an active project
 * that is not the scratch project, whose checkout has a `.dw/config.yml` with a `factory` block
 * (the opt-in, so a personal project's issues are never polled), and whose repository T3 resolved to a
 * GitHub `owner/name` through the `origin` remote. T3 prefers an `upstream` remote when a clone
 * has one, so such a clone (a fork) is not watched: its identity is the parent's. Those, and a
 * project that did not opt in, are left out without a word: no error, no attention item.
 *
 * What the reader could not settle is reported in `unresolved`, not dropped: a config file that
 * could not be read for a reason other than its absence, a config file that does not parse, a
 * checkout T3 could not name (git failed or timed out, no remote, a GitHub remote with no owner
 * or name), and a git that would not run.
 * The pass keeps its attention items while there are any. Every GitHub repo a checkout is a clone
 * of is reported in `present`, opted in or not: the pass clears a repo's attention items only when
 * no project is a clone of it any more, so a working tree that stops opting in (an older branch,
 * a file without the block, an `upstream` remote added) loses nothing.
 *
 * The identity is resolved for every git checkout, opted in or not, so that `present` names every
 * repo a project is a clone of (T3 caches it for a minute); a directory with no `.git` that does
 * not opt in is not asked about. Only an opted-in checkout is watched, and only a watched repo's
 * issues reach GitHub. The file is read from the checkout on disk; the loop
 * still reads the default-branch copy from GitHub for the project config itself. A checkout whose
 * working tree has no file is read once more from the copy committed on origin's default branch
 * (`git show origin/HEAD:.dw/config.yml`): a clone switched to an older branch has not left the
 * factory, and its `stuck` and `needs-info` items must not be cleared for it. That is one short
 * git call per pass for a git checkout with no file; a directory with no `.git` spawns nothing.
 * A repo that two projects name appears once per project: the reader reports facts, and the pass
 * decides what to do.
 */

export class WatchedReposError extends Schema.TaggedError<WatchedReposError>()(
  "FactoryWatchedReposError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `cannot list the T3 projects: ${detail}`;
  }
}

export class FactoryWatchedRepos extends Context.Service<
  FactoryWatchedRepos,
  {
    /** The watched projects in the order T3 lists them, read afresh on every call. */
    readonly list: Effect.Effect<WatchedListing, WatchedReposError>;
  }
>()("t3/factory/t3/watchedRepos/FactoryWatchedRepos") {}

/** What reading a checkout's `.dw/config.yml` came to. */
type Read =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unresolved" };

const ABSENT: Read = { kind: "absent" };
const UNRESOLVED: Read = { kind: "unresolved" };

export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const isCheckout = (root: string): Effect.Effect<boolean> =>
    fs.exists(path.join(root, ".git")).pipe(Effect.orElseSucceed(() => false));

  // The copy committed on origin's default branch, for a checkout whose working tree has none.
  // `git show` fails for a directory that is no clone, a clone with no `origin/HEAD` and a branch
  // with no such file, all of which are "not opted in"; a git that times out did not finish.
  const committed = (root: string): Effect.Effect<Read> =>
    Effect.gen(function* () {
      if (!(yield* isCheckout(root))) return ABSENT;
      const shown = yield* runner
        .run({
          command: "git",
          args: ["-C", root, "show", `origin/HEAD:${PROJECT_CONFIG_PATH}`],
          timeout: "10 seconds",
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.option);
      // A git that cannot run (not on PATH, or refused) has read nothing.
      if (Option.isNone(shown) || shown.value.timedOut) return UNRESOLVED;
      return shown.value.code === 0 ? { kind: "text", text: shown.value.stdout } : ABSENT;
    });

  // No file is "not opted in", once the committed copy says so too. Any other failure (EACCES,
  // EIO, a timeout) is a read that did not finish, which is not the same as the project leaving.
  const read = (root: string): Effect.Effect<Read> =>
    fs.readFileString(path.join(root, PROJECT_CONFIG_PATH)).pipe(
      Effect.map((text): Read => ({ kind: "text", text })),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound" ? committed(root) : Effect.succeed(UNRESOLVED),
      ),
    );

  const list = Effect.gen(function* () {
    const rows = yield* projects
      .list()
      .pipe(Effect.mapError((cause) => new WatchedReposError({ cause })));
    const scratch = yield* folders.scratchRoot;
    const scratchRoot = Option.map(scratch, (root) => path.resolve(root));
    const repos: Array<WatchedProject> = [];
    const present = new Set<string>();
    const unresolved: Array<string> = [];
    for (const row of rows) {
      const root = row.workspaceRoot;
      if (Option.isSome(scratchRoot) && path.resolve(root) === scratchRoot.value) continue;
      const file = yield* read(root);
      if (file.kind === "unresolved") {
        unresolved.push(root);
        continue;
      }
      const optIn = file.kind === "absent" ? "no" : factoryOptIn(file.text);
      if (optIn === "unparsed") {
        // A conflicted or half-saved file is a read that did not finish, not a project that left.
        unresolved.push(root);
        continue;
      }
      // A directory that is no git checkout and does not opt in is nobody's clone: T3 is not asked.
      if (optIn === "no" && !(yield* isCheckout(root))) continue;
      const identity = yield* identities.resolve(root);
      if (identity === null) {
        // Git failed or timed out (T3 caches the null for a minute), or the checkout has no
        // remote: T3 answers both alike, so whose clone it is stays unknown, opted in or not.
        unresolved.push(root);
        continue;
      }
      if (identity.provider !== "github") continue;
      const { owner, name } = identity;
      const named = owner !== undefined && name !== undefined ? `${owner}/${name}` : null;
      if (named === null) {
        // A GitHub remote T3 could not split into an owner and a name may be any repo's clone.
        unresolved.push(root);
        continue;
      }
      present.add(named);
      if (identity.origin?.displayName !== undefined) present.add(identity.origin.displayName);
      // T3 names a clone by its `upstream` remote when it has one, so only `origin` is the repo
      // the person cloned and works in.
      if (optIn === "yes" && identity.locator.remoteName === "origin") {
        repos.push({ repo: named, path: root, title: row.title });
      }
    }
    return { repos, present: [...present], unresolved } satisfies WatchedListing;
  });

  return FactoryWatchedRepos.of({ list });
});

export const layer = Layer.effect(FactoryWatchedRepos, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
