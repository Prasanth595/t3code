/**
 * Fork: the groups of the preview "Local servers" list (`previewLocalServerGroups`). Upstream
 * lists only the servers of T3 terminals. This service lists every other local listener and the
 * project folder that its process runs in, so a client shows them in groups: same worktree, same
 * project, then all others.
 *
 * Upstream sends HTTP only to listeners of T3 terminals, because a request to an unknown app can
 * crash it (pingdotgg/t3code#18377). This service keeps that rule for every listener outside the
 * projects: it lists them with the port and the process name only. It checks a listener only when
 * its process runs inside a root or worktree of a project of this server, because there the user
 * runs their own dev servers.
 *
 * `PortScanner.ts` calls `scannerHook` once per scan, so the upstream scan keeps its cost while
 * nobody subscribes or the setting is off.
 *
 * The list fills in progressively: every listener shows as soon as its folder is known, and each
 * HTTP check updates its own row when it ends. Rows keep the order in which they first appeared.
 */
import {
  type DiscoveredLocalServer,
  type ForkLocalListener,
  type ForkLocalListenerList,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";

const LSOF_TIMEOUT = Duration.seconds(5);
const PROCESS_TABLE_MAX_BYTES = 8 * 1024 * 1024;
// Deep enough for a server under a package runner under a shell under the agent CLI.
const MAX_ANCESTORS = 16;
// Provider CLIs pass their session or thread id in their arguments, and Claude Code and Codex
// export it to commands (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`). T3 stores it as the
// `nativeThreadRef.nativeId` of a provider thread. Revisit when a provider changes that id form.
const NATIVE_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SESSION_ENV_NAMES = new Set(["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]);
// Limit: a new project or thread worktree counts only after this time. Revisit when a server
// that starts in a new worktree must show in its group sooner.
const FOLDERS_TTL_MS = Duration.toMillis(Duration.seconds(30));
// `git worktree list` runs once per project, so it refreshes less often. A worktree that no
// thread uses counts after up to this time.
const GIT_WORKTREES_TTL_MS = Duration.toMillis(Duration.minutes(5));
const PROBE_TTL_MS = Duration.toMillis(Duration.seconds(15));
const PROBE_CONCURRENCY = 16;
// Checks that end together send one list, not one list each.
const PUBLISH_WINDOW = Duration.millis(50);
const GIT_CONCURRENCY = 4;

/** A project root or worktree as the server stores it, and the folder it resolves to. */
export interface ProjectFolder {
  readonly projectId: ProjectId;
  readonly folder: string;
  readonly realPath: string;
}

export interface ScanObservation {
  /** Every local listener of the scan. */
  readonly listeners: ReadonlyArray<DiscoveredLocalServer>;
  /**
   * Ports with more than one owner process, such as one on IPv4 and one on IPv6. A listener keeps
   * only the first owner, so a request to the port can reach the other process.
   */
  readonly sharedPorts: ReadonlySet<number>;
  /** The upstream web check: the URL that serves a page, or null. */
  readonly probe: (url: string) => Effect.Effect<string | null>;
}

export class PreviewServerGroups extends Context.Service<
  PreviewServerGroups,
  {
    /** True while a client subscribes and the setting is on. */
    readonly active: Effect.Effect<boolean>;
    readonly observe: (scan: ScanObservation) => Effect.Effect<void>;
    readonly listeners: Stream.Stream<ForkLocalListenerList>;
  }
>()("t3/fork/PreviewServerGroups") {}

const INACTIVE: PreviewServerGroups["Service"] = {
  active: Effect.succeed(false),
  observe: () => Effect.void,
  listeners: Stream.empty,
};

/** The hook of `PortScanner.ts`. Without the service (for example in its tests) it does nothing. */
export const scannerHook = Effect.serviceOption(PreviewServerGroups).pipe(
  Effect.map(Option.getOrElse(() => INACTIVE)),
);

/**
 * Resolves symlinks, drops folders that do not exist, keeps the first entry for each real folder,
 * and puts the deepest folders first. It also drops the home folder and every folder above it: a
 * project there would put nearly every process inside a project.
 *
 * Limit: two projects with the same root keep only the first project, so the servers there are in
 * the "all others" group for a thread of the second project. That changes no HTTP check, because
 * every project folder gets one. Revisit if a group must name every project of a folder.
 */
export const resolveProjectFolders = Effect.fn("PreviewServerGroups.resolveProjectFolders")(
  function* (folders: ReadonlyArray<Omit<ProjectFolder, "realPath">>) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homePath = path.resolve(yield* HostProcess.HomeDirectory);
    const home = yield* fileSystem.realPath(homePath).pipe(Effect.orElseSucceed(() => homePath));
    const resolved = yield* Effect.forEach(folders, (entry) =>
      fileSystem.realPath(path.resolve(entry.folder)).pipe(
        Effect.map((realPath) => ({ ...entry, realPath })),
        Effect.option,
      ),
    );
    const byRealPath = new Map<string, ProjectFolder>();
    for (const entry of resolved) {
      if (Option.isNone(entry) || isWithinRoot(path, home, entry.value.realPath)) continue;
      if (!byRealPath.has(entry.value.realPath)) byRealPath.set(entry.value.realPath, entry.value);
    }
    return [...byRealPath.values()].toSorted(
      (left, right) => right.realPath.length - left.realPath.length,
    );
  },
);

/** The HTTP checks that a pass knows about. */
export interface ListenerChecks {
  /** The last result: a page URL, null for no page, or undefined before the first check. */
  readonly last: (listener: DiscoveredLocalServer) => string | null | undefined;
  /** A new check, or null while the last result is fresh. */
  readonly run: (listener: DiscoveredLocalServer) => Effect.Effect<string | null> | null;
}

const withCheck = (row: ForkLocalListener, url: string | null | undefined): ForkLocalListener =>
  url === undefined
    ? { ...row, check: "checking" }
    : url === null
      ? { ...row, check: "noPage" }
      : { ...row, url, check: "page" };

/**
 * Places each listener by the real working folder of its process and publishes every row at once.
 * Only a listener inside a project folder, on a port with one owner, gets a check. It shows its
 * last result, or "checking" before the first one, and each check publishes again when it ends.
 */
export const placeListeners = Effect.fn("PreviewServerGroups.placeListeners")(function* (input: {
  readonly listeners: ReadonlyArray<DiscoveredLocalServer>;
  readonly cwdByPid: ReadonlyMap<number, string | null>;
  readonly threadByPid: ReadonlyMap<number, ThreadId>;
  readonly folders: ReadonlyArray<ProjectFolder>;
  readonly sharedPorts: ReadonlySet<number>;
  readonly checks: ListenerChecks;
  readonly publish: (rows: ReadonlyArray<ForkLocalListener>) => Effect.Effect<void>;
}) {
  const path = yield* Path.Path;
  const checkable: Array<{
    readonly index: number;
    readonly listener: DiscoveredLocalServer;
    readonly row: ForkLocalListener;
  }> = [];
  const rows = input.listeners.map((listener, index) => {
    const cwd = listener.pid === null ? null : (input.cwdByPid.get(listener.pid) ?? null);
    // Deepest first, so a worktree inside a project root wins over the root.
    const folder =
      cwd === null
        ? undefined
        : input.folders.find((entry) => isWithinRoot(path, cwd, entry.realPath));
    const row: ForkLocalListener = {
      host: listener.host,
      port: listener.port,
      url: listener.url,
      processName: listener.processName,
      pid: listener.pid,
      folder: folder === undefined ? null : { projectId: folder.projectId, folder: folder.folder },
      check: "unchecked",
      threadId: listener.pid === null ? null : (input.threadByPid.get(listener.pid) ?? null),
    };
    if (folder === undefined || input.sharedPorts.has(listener.port)) return row;
    checkable.push({ index, listener, row });
    return withCheck(row, input.checks.last(listener));
  });
  yield* input.publish([...rows]);
  yield* Effect.forEach(
    checkable,
    ({ index, listener, row }) => {
      const check = input.checks.run(listener);
      return check === null
        ? Effect.void
        : check.pipe(
            Effect.flatMap((url) => {
              rows[index] = withCheck(row, url);
              return input.publish([...rows]);
            }),
          );
    },
    { concurrency: PROBE_CONCURRENCY, discard: true },
  );
  return rows;
});

/** `lsof -Fn` output of `-d cwd`: a `p<pid>` line, then the `n<path>` line of its cwd. */
const parseLsofCwdOutput = (raw: string): ReadonlyMap<number, string> => {
  const cwdByPid = new Map<number, string>();
  let pid: number | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } else if (line.startsWith("n") && pid !== null && line.length > 1) {
      cwdByPid.set(pid, line.slice(1));
    }
  }
  return cwdByPid;
};

/** `ps -o pid=,ppid=,command=` output: the parent and the command line of each process. */
export const parseProcessTable = (
  raw: string,
): ReadonlyMap<number, { readonly ppid: number; readonly command: string }> => {
  const processes = new Map<number, { ppid: number; command: string }>();
  for (const line of raw.split("\n")) {
    const fields = line.trim();
    const pidEnd = fields.indexOf(" ");
    if (pidEnd < 0) continue;
    const rest = fields.slice(pidEnd).trimStart();
    const ppidEnd = rest.indexOf(" ");
    const pid = Number.parseInt(fields.slice(0, pidEnd), 10);
    const ppid = Number.parseInt(ppidEnd < 0 ? rest : rest.slice(0, ppidEnd), 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    processes.set(pid, { ppid, command: ppidEnd < 0 ? "" : rest.slice(ppidEnd + 1) });
  }
  return processes;
};

/** The native ids that each process and then each of its ancestors names, nearest first. */
export const nativeIdsUpTheTree = (
  pid: number,
  processes: ReadonlyMap<number, { readonly ppid: number; readonly command: string }>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const levels: Array<ReadonlyArray<string>> = [];
  let current = pid;
  for (let depth = 0; depth < MAX_ANCESTORS && current > 1; depth += 1) {
    const process = processes.get(current);
    if (process === undefined) break;
    levels.push((process.command.match(NATIVE_ID_PATTERN) ?? []).map((id) => id.toLowerCase()));
    current = process.ppid;
  }
  return levels;
};

/**
 * The thread of the nearest level that names a known native id. A level that names two threads
 * stops the walk without a thread, because the match is not certain.
 */
export const findOwnerThread = (
  levels: ReadonlyArray<ReadonlyArray<string>>,
  threadByNativeId: ReadonlyMap<string, string>,
): string | null => {
  for (const level of levels) {
    const threads = new Set(level.flatMap((id) => threadByNativeId.get(id) ?? []));
    if (threads.size > 1) return null;
    const [threadId] = threads;
    if (threadId !== undefined) return threadId;
  }
  return null;
};

const sameListeners = (
  left: ReadonlyArray<ForkLocalListener>,
  right: ReadonlyArray<ForkLocalListener>,
): boolean => JSON.stringify(left) === JSON.stringify(right);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcess.Platform;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const scope = yield* Effect.scope;

  const subscribersRef = yield* Ref.make(0);
  const listenersRef = yield* SubscriptionRef.make<ReadonlyArray<ForkLocalListener>>([]);
  const passSemaphore = yield* Semaphore.make(1);
  // A server rarely changes its folder or its parents after it listens, so each PID is read once.
  const processCacheRef = yield* Ref.make<
    ReadonlyMap<
      number,
      {
        readonly processName: string | null;
        readonly cwd: string | null;
        readonly threadId: ThreadId | null;
      }
    >
  >(new Map());
  const foldersRef = yield* Ref.make<{
    readonly folders: ReadonlyArray<ProjectFolder>;
    readonly expiresAtMillis: number;
  }>({ folders: [], expiresAtMillis: 0 });
  const gitWorktreesRef = yield* Ref.make<{
    readonly worktrees: ReadonlyArray<{ readonly projectId: ProjectId; readonly folder: string }>;
    readonly expiresAtMillis: number;
  }>({ worktrees: [], expiresAtMillis: 0 });
  // An expired entry still shows its result while the next check runs, so a row does not flip.
  const probeCacheRef = yield* Ref.make<
    ReadonlyMap<string, { readonly url: string | null; readonly expiresAtMillis: number }>
  >(new Map());
  // The order in which ports first appeared. A new server goes to the end of its group, so the
  // rows above it do not move.
  const orderRef = yield* Ref.make<{
    readonly seqByPort: ReadonlyMap<number, number>;
    readonly next: number;
  }>({ seqByPort: new Map(), next: 0 });

  const enabled = settings.getSettings.pipe(
    Effect.map((current) => current.previewLocalServerGroups),
    Effect.orElseSucceed(() => false),
  );

  const active = Effect.gen(function* () {
    return (yield* Ref.get(subscribersRef)) > 0 && (yield* enabled);
  });

  // `SubscriptionRef.set` notifies on every call, so each write first checks for a change.
  const publish = (next: ReadonlyArray<ForkLocalListener>) =>
    SubscriptionRef.get(listenersRef).pipe(
      Effect.flatMap((current) =>
        sameListeners(current, next) ? Effect.void : SubscriptionRef.set(listenersRef, next),
      ),
    );
  const clear = publish([]);

  const pendingRef = yield* Ref.make<ReadonlyArray<ForkLocalListener> | null>(null);
  const publishSoon = (rows: ReadonlyArray<ForkLocalListener>) =>
    Ref.getAndSet(pendingRef, rows).pipe(
      Effect.flatMap((waiting) =>
        waiting !== null
          ? Effect.void
          : Effect.sleep(PUBLISH_WINDOW).pipe(
              Effect.andThen(Ref.getAndSet(pendingRef, null)),
              Effect.flatMap((latest) =>
                latest === null
                  ? Effect.void
                  : // The setting can turn off while the checks run.
                    active.pipe(Effect.flatMap((on) => (on ? publish(latest) : clear))),
              ),
              Effect.forkIn(scope),
            ),
      ),
    );

  // Windows has no cheap way to read the folder of another process, so every listener there is
  // `outside`. Revisit if a Windows API exposes it without a process per PID.
  // Null when the lookup itself failed, so the PIDs are read again on the next scan.
  const readCwds = Effect.fn("PreviewServerGroups.readCwds")(function* (
    pids: ReadonlyArray<number>,
  ): Effect.fn.Return<ReadonlyMap<number, string> | null> {
    if (pids.length === 0 || hostPlatform === "win32") return new Map<number, string>();
    if (hostPlatform === "linux") {
      const entries = yield* Effect.forEach(
        pids,
        (pid) =>
          fileSystem.readLink(`/proc/${pid}/cwd`).pipe(
            Effect.map((cwd) => [[pid, cwd] as const]),
            Effect.orElseSucceed(() => []),
          ),
        { concurrency: 16 },
      );
      return new Map(entries.flat());
    }
    // lsof exits with 1 when one PID is gone and still prints the others.
    return yield* processRunner
      .run({
        command: "lsof",
        args: ["-a", "-d", "cwd", "-p", pids.join(","), "-Fn"],
        timeout: LSOF_TIMEOUT,
        maxOutputBytes: 1024 * 1024,
      })
      .pipe(
        Effect.map((result) => (result.timedOut ? null : parseLsofCwdOutput(result.stdout))),
        Effect.orElseSucceed(() => null),
      );
  });

  /**
   * The T3 thread that started each process: the nearest process up the tree whose command line
   * (or, on Linux, whose session variable) names the native id of exactly one T3 provider thread.
   * Null when the lookup itself failed, so the PIDs are read again on the next scan.
   *
   * Limit: a server whose shell exited has `launchd` or `init` as its parent, so on macOS it gets
   * no thread. macOS hides the environment of other processes. Revisit if T3 records the process
   * groups of the commands that agents run.
   */
  const readOwners = Effect.fn("PreviewServerGroups.readOwners")(function* (
    pids: ReadonlyArray<number>,
  ): Effect.fn.Return<ReadonlyMap<number, ThreadId> | null> {
    if (pids.length === 0 || hostPlatform === "win32") return new Map<number, ThreadId>();
    const table = yield* processRunner
      .run({
        command: "ps",
        args: ["-A", "-ww", "-o", "pid=,ppid=,command="],
        timeout: LSOF_TIMEOUT,
        maxOutputBytes: PROCESS_TABLE_MAX_BYTES,
      })
      .pipe(
        Effect.map((result) => (result.timedOut ? null : parseProcessTable(result.stdout))),
        Effect.orElseSucceed(() => null),
      );
    if (table === null) return null;
    const levelsByPid = new Map<number, Array<ReadonlyArray<string>>>();
    for (const pid of pids) {
      const levels = [...nativeIdsUpTheTree(pid, table)];
      if (hostPlatform === "linux") {
        const environment = yield* fileSystem
          .readFileString(`/proc/${pid}/environ`)
          .pipe(Effect.orElseSucceed(() => ""));
        const fromEnvironment = environment.split("\0").flatMap((entry) => {
          const separator = entry.indexOf("=");
          return separator > 0 && SESSION_ENV_NAMES.has(entry.slice(0, separator))
            ? [entry.slice(separator + 1).toLowerCase()]
            : [];
        });
        levels.unshift(fromEnvironment);
      }
      levelsByPid.set(pid, levels);
    }
    const ids = [...new Set([...levelsByPid.values()].flat(2))];
    if (ids.length === 0) return new Map<number, ThreadId>();
    const rows = yield* sql<{ readonly threadId: string; readonly nativeId: string }>`
      SELECT provider.thread_id AS "threadId",
        lower(json_extract(provider.payload_json, '$.nativeThreadRef.nativeId')) AS "nativeId"
      FROM orchestration_v2_projection_provider_threads AS provider
      JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = provider.thread_id AND thread.deleted_at IS NULL
      WHERE lower(json_extract(provider.payload_json, '$.nativeThreadRef.nativeId')) IN ${sql.in(ids)}
    `.pipe(Effect.orElseSucceed(() => null));
    if (rows === null) return null;
    const threadByNativeId = new Map(rows.map((row) => [row.nativeId, row.threadId] as const));
    const owners = new Map<number, ThreadId>();
    for (const [pid, levels] of levelsByPid) {
      const threadId = findOwnerThread(levels, threadByNativeId);
      if (threadId !== null) owners.set(pid, ThreadId.make(threadId));
    }
    return owners;
  });

  const processesFor = Effect.fn("PreviewServerGroups.processesFor")(function* (
    listeners: ReadonlyArray<DiscoveredLocalServer>,
  ) {
    const cached = yield* Ref.get(processCacheRef);
    const processes = new Map<number, string | null>();
    for (const listener of listeners) {
      if (listener.pid !== null) processes.set(listener.pid, listener.processName);
    }
    const unknown = [...processes].flatMap(([pid, processName]) =>
      cached.get(pid)?.processName === processName ? [] : [pid],
    );
    const [read, owners] = yield* Effect.all([readCwds(unknown), readOwners(unknown)], {
      concurrency: 2,
    });
    const resolved = yield* Effect.forEach([...(read ?? [])], ([pid, cwd]) =>
      fileSystem.realPath(cwd).pipe(
        Effect.map((real) => [pid, real] as const),
        Effect.orElseSucceed(() => [pid, null] as const),
      ),
    );
    const realByPid = new Map(resolved);
    const next = new Map<
      number,
      { processName: string | null; cwd: string | null; threadId: ThreadId | null }
    >();
    for (const [pid, processName] of processes) {
      const entry = cached.get(pid);
      if (entry?.processName === processName) next.set(pid, entry);
      else if (read !== null && owners !== null) {
        next.set(pid, {
          processName,
          cwd: realByPid.get(pid) ?? null,
          threadId: owners.get(pid) ?? null,
        });
      }
    }
    yield* Ref.set(processCacheRef, next);
    return {
      cwdByPid: new Map([...next].map(([pid, entry]) => [pid, entry.cwd] as const)),
      threadByPid: new Map(
        [...next].flatMap(([pid, entry]) =>
          entry.threadId === null ? [] : [[pid, entry.threadId] as const],
        ),
      ),
    };
  });

  const gitWorktrees = Effect.fn("PreviewServerGroups.gitWorktrees")(function* (
    projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>,
  ) {
    const nowMillis = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(gitWorktreesRef);
    if (cached.expiresAtMillis > nowMillis) return cached.worktrees;
    const worktrees = (yield* Effect.forEach(
      projects,
      (project) =>
        git.listWorktreePaths(project.workspaceRoot).pipe(
          Effect.map((paths) => paths.map((folder) => ({ projectId: project.id, folder }))),
          Effect.orElseSucceed(() => []),
        ),
      { concurrency: GIT_CONCURRENCY },
    )).flat();
    yield* Ref.set(gitWorktreesRef, {
      worktrees,
      expiresAtMillis: nowMillis + GIT_WORKTREES_TTL_MS,
    });
    return worktrees;
  });

  const loadFolders = Effect.fn("PreviewServerGroups.loadFolders")(function* () {
    const projects = yield* projectStore.listShells().pipe(Effect.orElseSucceed(() => []));
    const projectsById = new Map<string, (typeof projects)[number]>(
      projects.map((project) => [project.id, project]),
    );
    // The same query as `KnownWorkspaces`: thread worktrees come first, so a folder keeps the
    // path string that the threads of a client hold.
    const threads = yield* sql<{ readonly worktreePath: string; readonly projectId: string }>`
      SELECT DISTINCT
        json_extract(payload_json, '$.worktreePath') AS "worktreePath",
        project_id AS "projectId"
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
    `.pipe(Effect.orElseSucceed(() => []));
    const worktrees = yield* gitWorktrees(projects);
    return yield* resolveProjectFolders([
      ...threads.flatMap(({ worktreePath, projectId }) => {
        const project = projectsById.get(projectId);
        return project === undefined || !path.isAbsolute(worktreePath)
          ? []
          : [{ projectId: project.id, folder: worktreePath }];
      }),
      ...projects.map((project) => ({ projectId: project.id, folder: project.workspaceRoot })),
      ...worktrees,
    ]).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  });

  const currentFolders = Effect.fn("PreviewServerGroups.currentFolders")(function* () {
    const nowMillis = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(foldersRef);
    if (cached.expiresAtMillis > nowMillis) return cached.folders;
    const folders = yield* loadFolders();
    yield* Ref.set(foldersRef, { folders, expiresAtMillis: nowMillis + FOLDERS_TTL_MS });
    return folders;
  });

  const inFirstSeenOrder = Effect.fn("PreviewServerGroups.inFirstSeenOrder")(function* (
    listeners: ReadonlyArray<DiscoveredLocalServer>,
  ) {
    const known = yield* Ref.get(orderRef);
    const seqByPort = new Map<number, number>();
    let next = known.next;
    for (const { port } of listeners) seqByPort.set(port, known.seqByPort.get(port) ?? next++);
    yield* Ref.set(orderRef, { seqByPort, next });
    return listeners.toSorted(
      (left, right) => (seqByPort.get(left.port) ?? 0) - (seqByPort.get(right.port) ?? 0),
    );
  });

  const pass = Effect.fn("PreviewServerGroups.pass")(function* (scan: ScanObservation) {
    // A listener of a T3 terminal that the upstream list hides serves no page. Upstream checks
    // it already, so it gets no second request.
    const listeners = yield* inFirstSeenOrder(
      scan.listeners.filter((listener) => listener.terminal === null),
    );
    const { cwdByPid, threadByPid } = yield* processesFor(listeners);
    const folders = yield* currentFolders();
    const nowMillis = yield* Clock.currentTimeMillis;
    const cache = yield* Ref.get(probeCacheRef);
    const keyOf = (listener: DiscoveredLocalServer) =>
      `${listener.pid ?? ""}\u0000${listener.port}`;
    const checks: ListenerChecks = {
      last: (listener) => cache.get(keyOf(listener))?.url,
      run: (listener) => {
        const key = keyOf(listener);
        const cached = cache.get(key);
        if (cached !== undefined && cached.expiresAtMillis > nowMillis) return null;
        const base = `${listener.host}:${listener.port}`;
        return Effect.gen(function* () {
          const url =
            (yield* scan.probe(`http://${base}`)) ?? (yield* scan.probe(`https://${base}`));
          const checkedAtMillis = yield* Clock.currentTimeMillis;
          yield* Ref.update(probeCacheRef, (current) =>
            new Map(current).set(key, { url, expiresAtMillis: checkedAtMillis + PROBE_TTL_MS }),
          );
          return url;
        });
      },
    };
    yield* placeListeners({
      listeners,
      cwdByPid,
      threadByPid,
      folders,
      sharedPorts: scan.sharedPorts,
      checks,
      publish: publishSoon,
    }).pipe(Effect.provideService(Path.Path, path));
    const keys = new Set(listeners.map(keyOf));
    yield* Ref.update(
      probeCacheRef,
      (current) => new Map([...current].filter(([key]) => keys.has(key))),
    );
  });

  const observe: PreviewServerGroups["Service"]["observe"] = (scan) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(subscribersRef)) === 0) return;
      if (!(yield* enabled)) return yield* clear;
      // In the background, so the upstream list does not wait for the folder reads and checks.
      // A scan that comes while a pass runs is skipped; the next scan is 3 seconds later.
      yield* passSemaphore
        .withPermitsIfAvailable(1)(pass(scan))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("preview local server groups failed", Cause.pretty(cause)),
          ),
          Effect.forkIn(scope),
        );
    });

  const listeners: PreviewServerGroups["Service"]["listeners"] = Stream.unwrap(
    Effect.acquireRelease(
      Ref.update(subscribersRef, (count) => count + 1),
      () =>
        Ref.updateAndGet(subscribersRef, (count) => count - 1).pipe(
          Effect.flatMap((remaining) => (remaining === 0 ? clear : Effect.void)),
        ),
    ).pipe(
      Effect.as(
        SubscriptionRef.changes(listenersRef).pipe(
          Stream.map((current) => ({ listeners: current })),
        ),
      ),
    ),
  );

  return PreviewServerGroups.of({ active, observe, listeners });
});

export const layer = Layer.effect(PreviewServerGroups, make);
