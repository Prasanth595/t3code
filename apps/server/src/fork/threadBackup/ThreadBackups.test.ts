import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  FORK_THREAD_BACKUP_ROUTE,
  ForkThreadBackup,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { emptyProjection } from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as MachinePeers from "../machineMap/MachinePeers.ts";
import * as ThreadBackups from "./ThreadBackups.ts";

const sourceEnvironmentId = EnvironmentId.make("pc-environment");
const threadId = ThreadId.make("thread-on-pc");
const projectId = ProjectId.make("project-on-pc");
const codex = ProviderInstanceId.make("codex");
const decodeBackup = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(ForkThreadBackup)),
);

const makeShell = (now: DateTime.Utc): OrchestrationV2ThreadShell => ({
  id: threadId,
  projectId,
  title: "Fix the login page",
  providerInstanceId: codex,
  modelSelection: { instanceId: codex, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  branch: "fix/login",
  worktreePath: null,
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: now,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  pinnedAt: null,
  deletedAt: null,
});

const makeLayer = (input: {
  readonly backupMachine: string;
  readonly now: DateTime.Utc;
  readonly posted: Deferred.Deferred<{ machine: string; path: string; body: string }>;
}) => {
  const shell = makeShell(input.now);
  return ThreadBackups.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            threadBackupMachine: input.backupMachine,
          }),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(sourceEnvironmentId),
          getDescriptor: Effect.succeed({
            environmentId: sourceEnvironmentId,
            label: "Tom's PC",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          }),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          streamDomainEvents: Stream.never,
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [shell],
              archivedThreads: [],
            }),
          getThreadShell: () => Effect.succeed(shell),
          getThreadSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 1,
              projection: emptyProjection({
                id: EventId.make("event-created"),
                type: "thread.created",
                threadId,
                occurredAt: input.now,
                payload: {
                  id: threadId,
                  createdBy: "user",
                  creationSource: "web",
                  projectId,
                  title: shell.title,
                  providerInstanceId: codex,
                  modelSelection: shell.modelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: shell.branch,
                  worktreePath: null,
                  activeProviderThreadId: null,
                  lineage: shell.lineage,
                  forkedFrom: null,
                  createdAt: input.now,
                  updatedAt: input.now,
                  archivedAt: null,
                  settledOverride: null,
                  settledAt: null,
                  lastVisitedAt: null,
                  deletedAt: null,
                },
              }),
            }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          getShell: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(MachinePeers.MachinePeers)({
          postJson: (request) => Deferred.succeed(input.posted, request).pipe(Effect.asVoid),
        }),
        ServerConfig.layerTest(process.cwd(), { prefix: "thread-backups-" }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};

describe("ThreadBackups", () => {
  it.effect("sends a recently changed thread to the backup machine", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const posted = yield* Deferred.make<{ machine: string; path: string; body: string }>();
      yield* Effect.gen(function* () {
        const backups = yield* ThreadBackups.ThreadBackups;
        yield* backups.start();
        const request = yield* Deferred.await(posted);
        expect(request.machine).toBe("vps");
        expect(request.path).toBe(FORK_THREAD_BACKUP_ROUTE);
        const backup = yield* decodeBackup(request.body);
        expect(backup.sourceEnvironmentId).toBe(sourceEnvironmentId);
        expect(backup.sourceLabel).toBe("Tom's PC");
        expect(backup.branch).toBe("fix/login");
        expect(backup.transcript.threadId).toBe(threadId);
        expect(backup.transcript.title).toBe("Fix the login page");
      }).pipe(Effect.scoped, Effect.provide(makeLayer({ backupMachine: "vps", now, posted })));
    }),
  );

  it.effect("keeps a backup from another machine and reads it back", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const posted = yield* Deferred.make<{ machine: string; path: string; body: string }>();
      yield* Effect.gen(function* () {
        const backups = yield* ThreadBackups.ThreadBackups;
        const backup: ForkThreadBackup = {
          sourceEnvironmentId,
          sourceLabel: "Tom's PC",
          project: { title: "t3code", workspaceRoot: "/home/tom/t3code", repositoryKey: null },
          branch: "fix/login",
          worktreePath: null,
          transcript: { threadId, title: "Fix the login page", updatedAt: now, items: [] },
          omittedItems: 0,
        };
        yield* backups.store(backup);
        const read = yield* backups.get({ environmentId: sourceEnvironmentId, threadId });
        expect(read?.transcript.title).toBe("Fix the login page");
        expect(read?.project?.workspaceRoot).toBe("/home/tom/t3code");
        expect(
          yield* backups.get({ environmentId: sourceEnvironmentId, threadId: ThreadId.make("x") }),
        ).toBeNull();
        // An id that could leave the backup folder never reads a file.
        expect(
          yield* backups.get({
            environmentId: EnvironmentId.make(".."),
            threadId: ThreadId.make("thread-on-pc"),
          }),
        ).toBeNull();
      }).pipe(Effect.provide(makeLayer({ backupMachine: "", now, posted })));
    }),
  );
});
