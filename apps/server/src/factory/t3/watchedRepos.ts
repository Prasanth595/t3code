import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import {
  hasFactoryBlock,
  PROJECT_CONFIG_PATH,
  type WatchedListing,
  type WatchedProject,
} from "../config.ts";

/**
 * The repos the factory watches, read from this environment's T3 projects: an active project
 * that is not the scratch project, whose checkout has a `.dw/config.yml` with a `factory` block
 * (the opt-in, so a personal project is never polled), and whose `origin` T3 resolved to a GitHub
 * `owner/name`. Anything else is left out without a word: no error, no attention item.
 *
 * The config file is read before the repository identity, so git is not run for the projects
 * that are not factory repos. The file is read from the checkout on disk; the loop still reads
 * the default-branch copy from GitHub for the project config itself.
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

export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

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
      // No file is "not opted in". Any other failure (EACCES, EIO, a timeout) is a read that did
      // not finish, which is not the same as the project leaving the list.
      const text = yield* fs.readFileString(path.join(row.workspaceRoot, PROJECT_CONFIG_PATH)).pipe(
        Effect.asSome,
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.sync(() => void unresolved.push(row.workspaceRoot)).pipe(
                Effect.as(Option.none<string>()),
              ),
        ),
      );
      if (Option.isNone(text) || !hasFactoryBlock(text.value)) continue;
      const identity = yield* identities.resolve(row.workspaceRoot);
      if (identity === null) {
        // Git failed or timed out, and T3 caches the null for a minute.
        unresolved.push(row.workspaceRoot);
        continue;
      }
      if (identity.provider !== "github") continue;
      const { owner, name } = identity;
      if (owner === undefined || name === undefined) continue;
      repos.push({ repo: `${owner}/${name}`, path: row.workspaceRoot, title: row.title });
    }
    return { repos, unresolved } satisfies WatchedListing;
  });

  return FactoryWatchedRepos.of({ list });
});

export const layer = Layer.effect(FactoryWatchedRepos, make);
