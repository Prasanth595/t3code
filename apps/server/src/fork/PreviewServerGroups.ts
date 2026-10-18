/**
 * Fork: the groups of the preview "Local servers" list (`previewLocalServerGroups`). Upstream
 * lists only the servers of T3 terminals. This service lists every other local listener and the
 * project folder that its process runs in, so a client shows them in groups: same worktree, same
 * project, then all others.
 *
 * Upstream sends HTTP only to listeners of T3 terminals, because a request to an unknown app can
 * crash it (pingdotgg/t3code#18377). This service keeps that rule for the "all others" group: it
 * lists those listeners with the port and the process name only. It checks a listener only when
 * its process runs inside a root or worktree of a project that a subscriber shows, because there
 * the user runs their own dev servers. With two lists open on two projects, each list can show
 * the checks of the other project in its "all others" group.
 *
 * `PortScanner.ts` calls `scannerHook` once per scan, so the upstream scan keeps its cost while
 * nobody subscribes or the setting is off.
 */
import {
  type DiscoveredLocalServer,
  type ForkLocalListener,
  type ForkLocalListenerList,
  type ProjectId,
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
import { isFilesystemRoot } from "../worktreesDirectory.ts";

const LSOF_TIMEOUT = Duration.seconds(5);
// Limit: a new project or worktree counts only after this time. Revisit when a server that
// starts in a new worktree must show in its group sooner.
const FOLDERS_TTL_MS = Duration.toMillis(Duration.seconds(30));
const PROBE_TTL_MS = Duration.toMillis(Duration.seconds(15));
const PROBE_CONCURRENCY = 16;
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
  /** The listeners that the upstream list shows. */
  readonly shown: ReadonlyArray<DiscoveredLocalServer>;
  /** The upstream web check: the URL that serves a page, or null. */
  readonly probe: (url: string) => Effect.Effect<string | null>;
}

export class PreviewServerGroups extends Context.Service<
  PreviewServerGroups,
  {
    /** True while a client subscribes and the setting is on. */
    readonly active: Effect.Effect<boolean>;
    readonly observe: (scan: ScanObservation) => Effect.Effect<void>;
    /** The listeners for a list of a thread in `projectId`, again on each change. */
    readonly listeners: (projectId: ProjectId) => Stream.Stream<ForkLocalListenerList>;
  }
>()("t3/fork/PreviewServerGroups") {}

const INACTIVE: PreviewServerGroups["Service"] = {
  active: Effect.succeed(false),
  observe: () => Effect.void,
  listeners: () => Stream.empty,
};

/** The hook of `PortScanner.ts`. Without the service (for example in its tests) it does nothing. */
export const scannerHook = Effect.serviceOption(PreviewServerGroups).pipe(
  Effect.map(Option.getOrElse(() => INACTIVE)),
);

/**
 * Resolves symlinks, drops folders that do not exist or are a filesystem root, keeps the first
 * entry for each real folder, and puts the deepest folders first.
 */
export const resolveProjectFolders = Effect.fn("PreviewServerGroups.resolveProjectFolders")(
  function* (folders: ReadonlyArray<Omit<ProjectFolder, "realPath">>) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolved = yield* Effect.forEach(folders, (entry) =>
      fileSystem.realPath(path.resolve(entry.folder)).pipe(
        Effect.map((realPath) => ({ ...entry, realPath })),
        Effect.option,
      ),
    );
    const byRealPath = new Map<string, ProjectFolder>();
    for (const entry of resolved) {
      if (Option.isNone(entry) || isFilesystemRoot(entry.value.realPath, path)) continue;
      if (!byRealPath.has(entry.value.realPath)) byRealPath.set(entry.value.realPath, entry.value);
    }
    return [...byRealPath.values()].toSorted(
      (left, right) => right.realPath.length - left.realPath.length,
    );
  },
);

/**
 * Places each listener by the real working folder of its process. Only a listener inside a
 * folder of a `checkedProjects` project gets `probe`.
 */
export const placeListeners = Effect.fn("PreviewServerGroups.placeListeners")(function* (input: {
  readonly listeners: ReadonlyArray<DiscoveredLocalServer>;
  readonly cwdByPid: ReadonlyMap<number, string | null>;
  readonly folders: ReadonlyArray<ProjectFolder>;
  readonly checkedProjects: ReadonlySet<ProjectId>;
  readonly probe: (listener: DiscoveredLocalServer) => Effect.Effect<string | null>;
}) {
  const path = yield* Path.Path;
  return yield* Effect.forEach(
    input.listeners,
    Effect.fnUntraced(function* (listener) {
      const cwd = listener.pid === null ? null : (input.cwdByPid.get(listener.pid) ?? null);
      // Deepest first, so a worktree inside a project root wins over the root.
      const folder =
        cwd === null
          ? undefined
          : input.folders.find((entry) => isWithinRoot(path, cwd, entry.realPath));
      const placed: ForkLocalListener = {
        host: listener.host,
        port: listener.port,
        url: listener.url,
        processName: listener.processName,
        pid: listener.pid,
        folder:
          folder === undefined ? null : { projectId: folder.projectId, folder: folder.folder },
        check: "unchecked",
      };
      if (folder === undefined || !input.checkedProjects.has(folder.projectId)) return placed;
      const pageUrl = yield* input.probe(listener);
      return pageUrl === null
        ? { ...placed, check: "noPage" as const }
        : { ...placed, url: pageUrl, check: "page" as const };
    }),
    { concurrency: PROBE_CONCURRENCY },
  );
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

  // Subscriber count of each project. Only these projects get HTTP checks.
  const subscribersRef = yield* Ref.make<ReadonlyMap<ProjectId, number>>(new Map());
  const listenersRef = yield* SubscriptionRef.make<ReadonlyArray<ForkLocalListener>>([]);
  const passSemaphore = yield* Semaphore.make(1);
  // A server rarely changes its folder after it listens, so each PID is read once.
  const cwdCacheRef = yield* Ref.make<
    ReadonlyMap<number, { readonly processName: string | null; readonly cwd: string | null }>
  >(new Map());
  const foldersRef = yield* Ref.make<{
    readonly folders: ReadonlyArray<ProjectFolder>;
    readonly expiresAtMillis: number;
  }>({ folders: [], expiresAtMillis: 0 });
  const probeCacheRef = yield* Ref.make<
    ReadonlyMap<string, { readonly url: string | null; readonly expiresAtMillis: number }>
  >(new Map());

  const enabled = settings.getSettings.pipe(
    Effect.map((current) => current.previewLocalServerGroups),
    Effect.orElseSucceed(() => false),
  );

  const active = Effect.gen(function* () {
    return (yield* Ref.get(subscribersRef)).size > 0 && (yield* enabled);
  });

  // `SubscriptionRef.set` notifies on every call, so each write first checks for a change.
  const publish = (next: ReadonlyArray<ForkLocalListener>) =>
    SubscriptionRef.get(listenersRef).pipe(
      Effect.flatMap((current) =>
        sameListeners(current, next) ? Effect.void : SubscriptionRef.set(listenersRef, next),
      ),
    );
  const clear = publish([]);

  // Windows has no cheap way to read the folder of another process, so every listener there is
  // `outside`. Revisit if a Windows API exposes it without a process per PID.
  const readCwds = Effect.fn("PreviewServerGroups.readCwds")(function* (
    pids: ReadonlyArray<number>,
  ) {
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
        Effect.map((result) => parseLsofCwdOutput(result.stdout)),
        Effect.orElseSucceed(() => new Map<number, string>()),
      );
  });

  const cwdsFor = Effect.fn("PreviewServerGroups.cwdsFor")(function* (
    listeners: ReadonlyArray<DiscoveredLocalServer>,
  ) {
    const cached = yield* Ref.get(cwdCacheRef);
    const processes = new Map<number, string | null>();
    for (const listener of listeners) {
      if (listener.pid !== null) processes.set(listener.pid, listener.processName);
    }
    const unknown = [...processes].flatMap(([pid, processName]) =>
      cached.get(pid)?.processName === processName ? [] : [pid],
    );
    const read = yield* readCwds(unknown);
    const resolved = yield* Effect.forEach([...read], ([pid, cwd]) =>
      fileSystem.realPath(cwd).pipe(
        Effect.map((real) => [pid, real] as const),
        Effect.orElseSucceed(() => [pid, null] as const),
      ),
    );
    const realByPid = new Map(resolved);
    const next = new Map<number, { processName: string | null; cwd: string | null }>();
    for (const [pid, processName] of processes) {
      const entry = cached.get(pid);
      next.set(
        pid,
        entry?.processName === processName
          ? entry
          : { processName, cwd: realByPid.get(pid) ?? null },
      );
    }
    yield* Ref.set(cwdCacheRef, next);
    return new Map([...next].map(([pid, entry]) => [pid, entry.cwd] as const));
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
    const worktrees = yield* Effect.forEach(
      projects,
      (project) =>
        git.listWorktreePaths(project.workspaceRoot).pipe(
          Effect.map((paths) => paths.map((folder) => ({ projectId: project.id, folder }))),
          Effect.orElseSucceed(() => []),
        ),
      { concurrency: GIT_CONCURRENCY },
    );
    return yield* resolveProjectFolders([
      ...threads.flatMap(({ worktreePath, projectId }) => {
        const project = projectsById.get(projectId);
        return project === undefined || !path.isAbsolute(worktreePath)
          ? []
          : [{ projectId: project.id, folder: worktreePath }];
      }),
      ...projects.map((project) => ({ projectId: project.id, folder: project.workspaceRoot })),
      ...worktrees.flat(),
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

  const pass = Effect.fn("PreviewServerGroups.pass")(function* (scan: ScanObservation) {
    const shownPorts = new Set(scan.shown.map((server) => server.port));
    const listeners = scan.listeners.filter((listener) => !shownPorts.has(listener.port));
    const cwdByPid = yield* cwdsFor(listeners);
    const folders = yield* currentFolders();
    const nowMillis = yield* Clock.currentTimeMillis;
    const probeCache = yield* Ref.get(probeCacheRef);
    const nextProbeCache = new Map<string, { url: string | null; expiresAtMillis: number }>();
    const probe = Effect.fnUntraced(function* (listener: DiscoveredLocalServer) {
      const key = `${listener.pid ?? ""}\u0000${listener.port}`;
      const cached = probeCache.get(key);
      if (cached !== undefined && cached.expiresAtMillis > nowMillis) {
        nextProbeCache.set(key, cached);
        return cached.url;
      }
      const base = `${listener.host}:${listener.port}`;
      const url = (yield* scan.probe(`http://${base}`)) ?? (yield* scan.probe(`https://${base}`));
      nextProbeCache.set(key, { url, expiresAtMillis: nowMillis + PROBE_TTL_MS });
      return url;
    });
    const checkedProjects = new Set((yield* Ref.get(subscribersRef)).keys());
    const placed = yield* placeListeners({
      listeners,
      cwdByPid,
      folders,
      checkedProjects,
      probe,
    }).pipe(Effect.provideService(Path.Path, path));
    yield* Ref.set(probeCacheRef, nextProbeCache);
    // The setting can turn off while the checks run.
    if (!(yield* active)) return yield* clear;
    yield* publish(placed);
  });

  const observe: PreviewServerGroups["Service"]["observe"] = (scan) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(subscribersRef)).size === 0) return;
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

  const changeSubscribers = (projectId: ProjectId, delta: 1 | -1) =>
    Ref.modify(subscribersRef, (current) => {
      const next = new Map(current);
      const count = (next.get(projectId) ?? 0) + delta;
      if (count > 0) next.set(projectId, count);
      else next.delete(projectId);
      return [next.size, next] as const;
    });

  const listeners: PreviewServerGroups["Service"]["listeners"] = (projectId) =>
    Stream.unwrap(
      Effect.acquireRelease(changeSubscribers(projectId, 1), () =>
        changeSubscribers(projectId, -1).pipe(
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
