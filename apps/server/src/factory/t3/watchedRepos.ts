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
import { type Defaulted, LOCKFILES } from "../defaultProject.ts";
import { asciiLower } from "../ledger/runId.ts";
import { writeFileAtomically } from "./files.ts";
import { FactoryPaths } from "./paths.ts";

/** Where the reader remembers the T3 projects each repo was watched from. */
export const MEMORY_FILE = "watched-projects.json";

/**
 * Active T3 projects whose checkout (or origin's default branch) has a `factory` block in
 * `.dw/config.yml`, or any checkout once `default_project` is set (`defaulted`), with `origin` on
 * GitHub; T3 prefers `upstream`, so a fork is left out. A repo has `departed` only when every
 * project for it in `watched-projects.json` is deleted, never because its checkout reads differently.
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
    /**
     * The watched projects in the order T3 lists them, read afresh on every call. Writes nothing.
     * `withDefault` when the machine has a `default_project`.
     */
    readonly list: (withDefault: boolean) => Effect.Effect<WatchedListing, WatchedReposError>;
    /** `list`, then the projects each watched repo comes from remembered for the next call: the pass's read. */
    readonly listAndRemember: (
      withDefault: boolean,
    ) => Effect.Effect<WatchedListing, WatchedReposError>;
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
   * The repos that departed. A repo's remembered projects are its remembered ones plus those
   * watching it now, less those since deleted: an id goes only when its project is deleted. A
   * repo departs when none is left. With `remember`, the memory is written for the next pass;
   * only the pass remembers.
   */
  const departures = Effect.fn("WatchedRepos.departures")(
    function* (
      watchedFrom: ReadonlyMap<string, ReadonlyArray<string>>,
      active: ReadonlySet<string>,
      remember: boolean,
    ) {
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
    },
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );

  const isCheckout = (root: string): Effect.Effect<boolean> =>
    fs.exists(path.join(root, ".git")).pipe(Effect.orElseSucceed(() => false));

  /** `git -C root <args>`: its output, null when it ended non-zero, "unresolved" when git did not finish. */
  const gitOutput = (root: string, args: ReadonlyArray<string>) =>
    runner
      .run({
        command: "git",
        args: ["-C", root, ...args],
        timeout: "10 seconds",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.option,
        // A git that cannot run (not on PATH, or refused) has read nothing.
        Effect.map((shown) =>
          Option.isNone(shown) || shown.value.timedOut
            ? ("unresolved" as const)
            : shown.value.code === 0
              ? shown.value.stdout
              : null,
        ),
      );

  // The copy committed on origin's default branch, for a checkout whose working tree has none.
  // `git show` fails for a directory that is no clone, a clone with no `origin/HEAD` and a branch
  // with no such file, all of which are "not opted in"; a git that times out did not finish.
  const committed = Effect.fn("WatchedRepos.committed")(function* (
    root: string,
  ): Effect.fn.Return<Read> {
    if (!(yield* isCheckout(root))) return ABSENT;
    const shown = yield* gitOutput(root, ["show", `origin/HEAD:${PROJECT_CONFIG_PATH}`]);
    if (shown === "unresolved") return UNRESOLVED;
    return shown === null ? ABSENT : { kind: "text", text: shown };
  });

  // The branch origin's HEAD names and the manifests committed at its root, for a project on the
  // default. A clone with no `origin/HEAD` has none to read, and its reading says so.
  const defaultedFiles = Effect.fn("WatchedRepos.defaultedFiles")(function* (
    root: string,
  ): Effect.fn.Return<Defaulted | "unresolved"> {
    const head = yield* gitOutput(root, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
    if (head === "unresolved") return head;
    if (head === null) return { head: null };
    const tree = yield* gitOutput(root, ["ls-tree", "--name-only", "origin/HEAD"]);
    if (tree === null || tree === "unresolved") return "unresolved";
    const names = new Set(tree.split("\n"));
    const shown = (name: string) =>
      names.has(name) ? gitOutput(root, ["show", `origin/HEAD:${name}`]) : Effect.succeed(null);
    const packageJson = yield* shown("package.json");
    const composerJson = yield* shown("composer.json");
    // A file the tree lists but git could not show is a read that did not finish.
    if (
      packageJson === "unresolved" ||
      composerJson === "unresolved" ||
      (packageJson === null && names.has("package.json")) ||
      (composerJson === null && names.has("composer.json"))
    ) {
      return "unresolved";
    }
    return {
      head: {
        branch: head.trim().replace(/^origin\//, ""),
        files: {
          packageJson,
          composerJson,
          lockfiles: LOCKFILES.filter((name) => names.has(name)),
        },
      },
    };
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

  const listing = Effect.fn("WatchedRepos.listing")(function* (
    remember: boolean,
    withDefault: boolean,
  ) {
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
      const optIn = file.kind === "text" ? factoryOptIn(file.text) : "no";
      if (optIn === "unparsed") {
        // A conflicted or half-saved file is a read that did not finish.
        unresolved.push(root);
        continue;
      }
      const onDefault = optIn === "no";
      if (onDefault && !(withDefault && (yield* isCheckout(root)))) continue;
      const identity = yield* identities.resolve(root);
      if (identity === null) {
        // Git failed or timed out, and T3 caches the null for a minute. A checkout on the default
        // also gets null for having no remote at all, which many a local project has: it is left
        // out rather than reported on every pass.
        if (!onDefault) unresolved.push(root);
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
      if (onDefault) {
        const defaulted = yield* defaultedFiles(root);
        if (defaulted === "unresolved") {
          unresolved.push(root);
          continue;
        }
        repos.push({ repo, path: root, title: row.title, defaulted });
      } else {
        repos.push({ repo, path: root, title: row.title });
      }
      const key = asciiLower(repo);
      watchedFrom.set(key, [...(watchedFrom.get(key) ?? []), row.projectId]);
    }
    const active = new Set<string>(rows.map((row) => row.projectId));
    const departed = yield* departures(watchedFrom, active, remember);
    // A repo that one project opts in is watched from that project: another checkout of it on the
    // default would only make it ambiguous.
    const ownBlock = new Set(
      repos.filter((entry) => entry.defaulted === undefined).map((entry) => asciiLower(entry.repo)),
    );
    return {
      repos: repos.filter(
        (entry) => entry.defaulted === undefined || !ownBlock.has(asciiLower(entry.repo)),
      ),
      departed,
      unresolved,
    } satisfies WatchedListing;
  });

  return FactoryWatchedRepos.of({
    list: Effect.fn("FactoryWatchedRepos.list")((withDefault: boolean) =>
      listing(false, withDefault),
    ),
    listAndRemember: Effect.fn("FactoryWatchedRepos.listAndRemember")((withDefault: boolean) =>
      listing(true, withDefault),
    ),
  });
});

/** Needs `FactoryPaths` for the memory file. */
export const layer = Layer.effect(FactoryWatchedRepos, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
