/**
 * Fork: thread backups (`packages/contracts/src/forkThreadBackup.ts`). A server with the setting
 * `threadBackupMachine` sends the transcript of each changed thread to that machine of the
 * machine map, through the same pairing as `machine_tool_call`. The machine that receives it
 * keeps the newest backups of each source in `<stateDir>/thread-backups/<environmentId>/`, and
 * its clients read them while the source is offline.
 */
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  FORK_THREAD_BACKUP_ROUTE,
  ForkThreadBackup,
  type ForkThreadBackupGetInput,
  repositoryGroupingKeyOf,
  type ThreadId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { newestTranscriptItems } from "@t3tools/shared/threadTranscript";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { forkParked } from "../../serverActivation.ts";
import { isMachineSubject } from "../machineMap/machineAccess.ts";
import * as MachinePeers from "../machineMap/MachinePeers.ts";

/** A backup carries the newest items up to this size, so a push stays cheap. */
const THREAD_BACKUP_MAX_BYTES = 4 * 1024 * 1024;
/** The newest backups that the receiving machine keeps per source machine. */
const KEPT_PER_SOURCE = 300;
const KEPT_FOR = Duration.days(30);
const PUSH_INTERVAL = Duration.seconds(30);
/** On start and on a new target, the threads that changed this recently get a first backup. */
const BACKFILL_WINDOW = Duration.days(3);
const BACKFILL_LIMIT = 50;

const BackupJson = Schema.fromJsonString(Schema.toCodecJson(ForkThreadBackup));
const encodeBackup = Schema.encodeEffect(BackupJson);
const decodeBackup = Schema.decodeUnknownEffect(BackupJson);

/** Ids are entity ids, but a file name must never leave the backup folder. */
const isSafeName = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);

export class ThreadBackups extends Context.Service<
  ThreadBackups,
  {
    /** Keeps a backup that another machine sent. */
    readonly store: (backup: ForkThreadBackup) => Effect.Effect<void>;
    readonly get: (input: ForkThreadBackupGetInput) => Effect.Effect<ForkThreadBackup | null>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/fork/threadBackup/ThreadBackups") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettings.ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const peers = yield* MachinePeers.MachinePeers;
  const root = path.join(config.stateDir, "thread-backups");

  const fileOf = (environmentId: string, threadId: string) =>
    isSafeName(environmentId) && isSafeName(threadId)
      ? Option.some(path.join(root, environmentId, `${threadId}.json`))
      : Option.none();

  /** Drops backups past `KEPT_FOR` and the oldest past `KEPT_PER_SOURCE`. */
  const prune = (folder: string) =>
    Effect.gen(function* () {
      const names = yield* fileSystem.readDirectory(folder);
      const now = yield* Clock.currentTimeMillis;
      const entries = yield* Effect.forEach(names, (name) =>
        fileSystem.stat(path.join(folder, name)).pipe(
          Effect.map((info) => ({
            file: path.join(folder, name),
            modifiedMs: Option.match(info.mtime, { onNone: () => 0, onSome: (at) => at.getTime() }),
          })),
        ),
      );
      const newestFirst = entries.toSorted((a, b) => b.modifiedMs - a.modifiedMs);
      const stale = newestFirst.filter(
        (entry, index) =>
          index >= KEPT_PER_SOURCE || now - entry.modifiedMs > Duration.toMillis(KEPT_FOR),
      );
      yield* Effect.forEach(stale, (entry) => fileSystem.remove(entry.file), { discard: true });
    });

  const store: ThreadBackups["Service"]["store"] = (backup) =>
    Effect.gen(function* () {
      const file = fileOf(backup.sourceEnvironmentId, backup.transcript.threadId);
      if (Option.isNone(file)) return;
      yield* fileSystem.makeDirectory(path.dirname(file.value), { recursive: true });
      const contents = yield* encodeBackup(backup);
      yield* writeFileStringAtomically({ filePath: file.value, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      yield* prune(path.dirname(file.value));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not keep a thread backup", { cause: String(cause) }),
      ),
    );

  const get: ThreadBackups["Service"]["get"] = (input) =>
    Effect.gen(function* () {
      const file = fileOf(input.environmentId, input.threadId);
      if (Option.isNone(file)) return null;
      if (!(yield* fileSystem.exists(file.value))) return null;
      return yield* fileSystem.readFileString(file.value).pipe(Effect.flatMap(decodeBackup));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not read a thread backup", { cause: String(cause) }).pipe(
          Effect.as(null),
        ),
      ),
    );

  const buildBackup = (threadId: ThreadId, sourceEnvironmentId: EnvironmentId) =>
    Effect.gen(function* () {
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.archivedAt !== null || shell.deletedAt !== null) return null;
      const { projection } = yield* threads.getThreadSnapshot(threadId);
      const project = yield* projects.getShell(shell.projectId);
      const descriptor = yield* serverEnvironment.getDescriptor;
      const fitted = newestTranscriptItems(projection.visibleTurnItems, THREAD_BACKUP_MAX_BYTES);
      return {
        sourceEnvironmentId,
        sourceLabel: descriptor.label,
        project: Option.match(project, {
          onNone: () => null,
          onSome: (shellProject) => ({
            title: shellProject.title,
            workspaceRoot: shellProject.workspaceRoot,
            repositoryKey: shellProject.repositoryIdentity
              ? repositoryGroupingKeyOf(shellProject.repositoryIdentity)
              : null,
          }),
        }),
        branch: shell.branch,
        worktreePath: shell.worktreePath,
        transcript: {
          threadId: projection.thread.id,
          title: projection.thread.title,
          updatedAt: projection.updatedAt,
          items: fitted.items,
        },
        omittedItems: fitted.omittedItems,
      } satisfies ForkThreadBackup;
    });

  // Threads changed since their last push. A failed push puts its thread back.
  const dirty = new Set<ThreadId>();
  let backfilledFor: string | null = null;

  const backfill = Effect.gen(function* () {
    const snapshot = yield* threads.getShellSnapshot();
    const since = DateTime.subtractDuration(yield* DateTime.now, BACKFILL_WINDOW);
    snapshot.threads
      .filter((thread) => DateTime.isGreaterThan(thread.updatedAt, since))
      .toSorted((a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt))
      .slice(0, BACKFILL_LIMIT)
      .forEach((thread) => dirty.add(thread.id));
  });

  const pushDirty = Effect.gen(function* () {
    const machine = (yield* settings.getSettings).threadBackupMachine;
    if (machine === "") {
      backfilledFor = null;
      dirty.clear();
      return;
    }
    if (backfilledFor !== machine) {
      backfilledFor = machine;
      yield* backfill;
    }
    if (dirty.size === 0) return;
    const sourceEnvironmentId = yield* serverEnvironment.getEnvironmentId;
    const batch = [...dirty];
    dirty.clear();
    for (const threadId of batch) {
      const pushed = yield* buildBackup(threadId, sourceEnvironmentId).pipe(
        Effect.flatMap((backup) =>
          backup === null
            ? Effect.succeed(true)
            : encodeBackup(backup).pipe(
                Effect.flatMap((body) =>
                  peers.postJson({ machine, path: FORK_THREAD_BACKUP_ROUTE, body }),
                ),
                Effect.as(true),
              ),
        ),
        Effect.catchTags({
          MachinePeerError: (error) =>
            Effect.logInfo("Thread backup not sent", {
              reason: error.reason,
              detail: error.detail,
            }).pipe(
              // A target that cannot exist on this map never takes a retry.
              Effect.as(error.reason === "unknown-machine" || error.reason === "not-on-map"),
            ),
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not build a thread backup", {
            threadId,
            cause: String(cause),
          }).pipe(Effect.as(true)),
        ),
      );
      if (!pushed) {
        // The target is offline or refused: keep the rest for the next pass.
        batch.slice(batch.indexOf(threadId)).forEach((id) => dirty.add(id));
        return;
      }
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Thread backup pass failed", { cause: String(cause) }),
    ),
  );

  const start: ThreadBackups["Service"]["start"] = Effect.fn("ThreadBackups.start")(function* () {
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event) =>
        Effect.sync(() => {
          if ("threadId" in event && typeof event.threadId === "string") {
            dirty.add(event.threadId as ThreadId);
          }
        }),
      ),
    );
    yield* forkParked(pushDirty.pipe(Effect.repeat(Schedule.spaced(PUSH_INTERVAL))));
  });

  return ThreadBackups.of({ store, get, start });
});

export const layer = Layer.effect(ThreadBackups, make);

/** Starts the thread watcher and the push loop. */
export const layerWorker = Layer.effectDiscard(
  ThreadBackups.pipe(Effect.flatMap((service) => service.start())),
);

/** Takes a backup from a machine of the map. Only a machine session with operate access may post. */
export const routeLayer = HttpRouter.add(
  "POST",
  FORK_THREAD_BACKUP_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
    if (Option.isNone(session)) return HttpServerResponse.text("Unauthorized", { status: 401 });
    if (
      !isMachineSubject(session.value.subject) ||
      !session.value.scopes.includes(AuthOrchestrationOperateScope)
    ) {
      return HttpServerResponse.text("Forbidden", { status: 403 });
    }
    const backup = yield* request.text.pipe(Effect.flatMap(decodeBackup), Effect.option);
    if (Option.isNone(backup)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const backups = yield* ThreadBackups;
    yield* backups.store(backup.value);
    return HttpServerResponse.empty({ status: 204 });
  }),
);
