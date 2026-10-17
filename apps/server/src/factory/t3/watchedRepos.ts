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
import { asciiLower } from "../ledger/runId.ts";
import { writeFileAtomically } from "./files.ts";
import { FactoryPaths } from "./paths.ts";

/** Where the reader remembers the T3 projects each repo was watched from. */
export const MEMORY_FILE = "watched-projects.json";

/**
 * The repos the factory watches, read from this environment's T3 projects: an active project
 * that is not the scratch project, whose checkout has a `.dw/config.yml` with a `factory` block
 * (the opt-in, so a personal project is never polled), and whose repository T3 resolved to a
 * GitHub `owner/name` through the `origin` remote. T3 prefers an `upstream` remote when a clone
 * has one, so such a clone (a fork) is not watched: its identity is the parent's. Those, and a
 * project that did not opt in, are left out without a word: no error, no attention item.
 *
 * What the reader could not settle is reported in `unresolved`, for the settings page: a config
 * file that could not be read for a reason other than its absence, one that does not parse, an
 * opted-in checkout T3 could not name, and a git that would not run.
 *
 * A repo has left the factory only when the T3 project it was watched from is deleted, never
 * because its checkout reads differently: a branch without the factory block, an `upstream`
 * remote added, an unmounted volume or a git that fails all leave the project in T3. So the reader
 * remembers, in `<factory dir>/watched-projects.json`, the T3 projects each repo was last watched
 * from, and reports in `departed` the repos it watches no more whose every remembered project has
 * since been deleted. That is the only list the pass clears attention items by: `stuck` and
 * `needs-info` items are raised once. A repo nobody watched since the file began is never in it.
 * A memory that cannot be read or parsed reports nothing departed and is left as it is. Only the
 * pass's read (`listAndRemember`) writes the file, and passes do not overlap.
 *
 * The config file is read before the repository identity, so the identity is not resolved for a
 * project that did not opt in. The file is read from the checkout on disk; the loop still reads
 * the default-branch copy from GitHub for the project config itself. A git checkout whose working
 * tree has no file is read once more from the copy committed on origin's default branch (`git
 * show origin/HEAD:.dw/config.yml`), so a clone switched to an older branch is still watched;
 * that is one short git call per pass, and a directory with no `.git` spawns nothing. A repo that
 * two projects name appears once per project: the reader reports facts, and the pass decides.
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
    /** The watched projects in the order T3 lists them, read afresh on every call. Writes nothing. */
    readonly list: Effect.Effect<WatchedListing, WatchedReposError>;
    /** `list`, then the projects each watched repo comes from remembered for the next call: the pass's read. */
    readonly listAndRemember: Effect.Effect<WatchedListing, WatchedReposError>;
  }
>()("t3/factory/t3/watchedRepos/FactoryWatchedRepos") {}

/** What reading a checkout's `.dw/config.yml` came to. */
type Read =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unresolved" };

const ABSENT: Read = { kind: "absent" };
const UNRESOLVED: Read = { kind: "unresolved" };

/** The project ids each repo was last watched from, by the repo folded with `asciiLower`. */
const MemoryJson = Schema.fromJsonString(
  Schema.Struct({ repos: Schema.Record(Schema.String, Schema.Array(Schema.String)) }),
);
type Memory = (typeof MemoryJson.Type)["repos"];

const decodeMemoryJson = Schema.decodeUnknownOption(MemoryJson);
const encodeMemoryJson = Schema.encodeSync(MemoryJson);

/** None for a file that is not the expected shape: like one that cannot be read, it is left alone. */
const decodeMemory = (text: string): Option.Option<Memory> =>
  Option.map(decodeMemoryJson(text), (memory) => memory.repos);
const encodeMemory = (repos: Memory): string => encodeMemoryJson({ repos });

export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const runner = yield* ProcessRunner.ProcessRunner;
  const { factoryDir } = yield* FactoryPaths;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const memoryFile = path.join(factoryDir, MEMORY_FILE);

  // None when the file exists and cannot be read or parsed: nothing is said to have departed
  // from it, and it is not written over, so no repo it remembers is lost.
  const readMemory: Effect.Effect<Option.Option<Memory>> = fs.readFileString(memoryFile).pipe(
    Effect.map(decodeMemory),
    Effect.catch((cause) =>
      Effect.succeed(cause.reason._tag === "NotFound" ? Option.some({}) : Option.none()),
    ),
  );

  /**
   * The repos that departed. A repo's remembered projects are its remembered ones and the ones
   * that watch it now, less those since deleted: an id goes only when its project does, so a
   * project that merely stops opting in, or cannot be read this pass, stays one of the repo's. A
   * repo departs when none is left. With `remember`, the memory is written for the next pass;
   * only the pass remembers, so the settings page's read changes nothing.
   */
  const departures = (
    watchedFrom: ReadonlyMap<string, ReadonlyArray<string>>,
    active: ReadonlySet<string>,
    remember: boolean,
  ): Effect.Effect<Array<string>> =>
    Effect.gen(function* () {
      const remembered = yield* readMemory;
      if (Option.isNone(remembered)) return [];
      const next: Record<string, ReadonlyArray<string>> = {};
      for (const repo of new Set([...Object.keys(remembered.value), ...watchedFrom.keys()])) {
        const ids = new Set([...(remembered.value[repo] ?? []), ...(watchedFrom.get(repo) ?? [])]);
        next[repo] = [...ids].filter((id) => active.has(id));
      }
      const departed = Object.entries(next)
        .filter(([, ids]) => ids.length === 0)
        .map(([repo]) => repo);
      if (remember && encodeMemory(next) !== encodeMemory(remembered.value)) {
        yield* writeFileAtomically(memoryFile, `${encodeMemory(next)}\n`).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(`cannot write ${memoryFile}: ${String(cause)}`),
          ),
        );
      }
      return departed;
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

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

  const listing = (remember: boolean) =>
    Effect.gen(function* () {
      const rows = yield* projects
        .list()
        .pipe(Effect.mapError((cause) => new WatchedReposError({ cause })));
      const scratch = yield* folders.scratchRoot;
      const scratchRoot = Option.map(scratch, (root) => path.resolve(root));
      const repos: Array<WatchedProject> = [];
      const watchedFrom = new Map<string, Array<string>>();
      const unresolved: Array<string> = [];
      for (const row of rows) {
        const root = row.workspaceRoot;
        if (Option.isSome(scratchRoot) && path.resolve(root) === scratchRoot.value) continue;
        const file = yield* read(root);
        if (file.kind === "unresolved") {
          unresolved.push(root);
          continue;
        }
        if (file.kind === "absent") continue;
        const optIn = factoryOptIn(file.text);
        if (optIn === "unparsed") {
          // A conflicted or half-saved file is a read that did not finish.
          unresolved.push(root);
          continue;
        }
        if (optIn === "no") continue;
        const identity = yield* identities.resolve(root);
        if (identity === null) {
          // Git failed or timed out, and T3 caches the null for a minute.
          unresolved.push(root);
          continue;
        }
        // T3 names a clone by its `upstream` remote when it has one, so only `origin` is the repo
        // the person cloned and works in.
        if (identity.provider !== "github" || identity.locator.remoteName !== "origin") continue;
        const { owner, name } = identity;
        if (owner === undefined || name === undefined) {
          unresolved.push(root);
          continue;
        }
        const repo = `${owner}/${name}`;
        repos.push({ repo, path: root, title: row.title });
        const key = asciiLower(repo);
        watchedFrom.set(key, [...(watchedFrom.get(key) ?? []), row.projectId]);
      }
      const active = new Set<string>(rows.map((row) => row.projectId));
      const departed = yield* departures(watchedFrom, active, remember);
      return { repos, departed, unresolved } satisfies WatchedListing;
    });

  return FactoryWatchedRepos.of({ list: listing(false), listAndRemember: listing(true) });
});

/** Needs `FactoryPaths` for the memory file. */
export const layer = Layer.effect(FactoryWatchedRepos, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
