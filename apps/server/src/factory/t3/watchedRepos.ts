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
 * (the opt-in, so a personal project is never polled), and whose repository T3 resolved to a
 * GitHub `owner/name` through the `origin` remote. T3 prefers an `upstream` remote when a clone
 * has one, so such a clone (a fork) is not watched: its identity is the parent's. Those, and a
 * project that did not opt in, are left out without a word: no error, no attention item.
 *
 * What the reader could not settle is reported in `unresolved`, not dropped: a config file that
 * could not be read for a reason other than its absence, a config file that does not parse, and
 * an opted-in checkout T3 could not identify (git failed or timed out). The pass keeps its attention items while there are any.
 *
 * The config file is read before the repository identity, so the identity is not resolved for
 * the projects that are not factory repos. The file is read from the checkout on disk; the loop
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

  // The copy committed on origin's default branch, for a checkout whose working tree has none.
  // `git show` fails for a directory that is no clone, a clone with no `origin/HEAD` and a branch
  // with no such file, all of which are "not opted in"; a git that times out did not finish.
  const committed = (root: string): Effect.Effect<Read> =>
    Effect.gen(function* () {
      const isCheckout = yield* fs
        .exists(path.join(root, ".git"))
        .pipe(Effect.orElseSucceed(() => false));
      if (!isCheckout) return ABSENT;
      const shown = yield* runner
        .run({
          command: "git",
          args: ["-C", root, "show", `origin/HEAD:${PROJECT_CONFIG_PATH}`],
          timeout: "10 seconds",
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.option);
      if (Option.isNone(shown)) return ABSENT;
      if (shown.value.timedOut) return UNRESOLVED;
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
    const unresolved: Array<string> = [];
    for (const row of rows) {
      if (Option.isSome(scratchRoot) && path.resolve(row.workspaceRoot) === scratchRoot.value) {
        continue;
      }
      const file = yield* read(row.workspaceRoot);
      if (file.kind === "unresolved") {
        unresolved.push(row.workspaceRoot);
        continue;
      }
      if (file.kind === "absent") continue;
      const optIn = factoryOptIn(file.text);
      if (optIn === "unparsed") {
        // A conflicted or half-saved file is a read that did not finish, not a project that left.
        unresolved.push(row.workspaceRoot);
        continue;
      }
      if (optIn === "no") continue;
      const identity = yield* identities.resolve(row.workspaceRoot);
      if (identity === null) {
        // Git failed or timed out, and T3 caches the null for a minute.
        unresolved.push(row.workspaceRoot);
        continue;
      }
      // T3 names a clone by its `upstream` remote when it has one, so only `origin` is the repo
      // the person cloned and works in.
      if (identity.provider !== "github" || identity.locator.remoteName !== "origin") continue;
      const { owner, name } = identity;
      if (owner === undefined || name === undefined) continue;
      repos.push({ repo: `${owner}/${name}`, path: row.workspaceRoot, title: row.title });
    }
    return { repos, unresolved } satisfies WatchedListing;
  });

  return FactoryWatchedRepos.of({ list });
});

export const layer = Layer.effect(FactoryWatchedRepos, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
