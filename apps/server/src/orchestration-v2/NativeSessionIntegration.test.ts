// @effect-diagnostics nodeBuiltinImport:off -- The synthetic Linux peer needs its real child PID/stdin and /proc file identities.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  EventId,
  NativeSessionAdoptInput,
  NativeSessionReleaseInput,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderSessionId,
  ThreadId,
  RunId,
  RunAttemptId,
  NodeId,
  MessageId,
  ChatImageAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SqlClient from "effect/sql/SqlClient";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as NativeSessionService from "./NativeSessionService.ts";
import * as NativeSessionStore from "./NativeSessionStore.ts";
import * as CodexAdapter from "./Adapters/CodexAdapterV2.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { NativeSessionWriteContext } from "./NativeSessionProtocol.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";

const decodeAdopt = Schema.decodeUnknownEffect(NativeSessionAdoptInput);
const decodeRelease = Schema.decodeUnknownEffect(NativeSessionReleaseInput);
const evidence = process.env.T3_NATIVE_SESSION_TEST_EVIDENCE_DIR ?? NodeOS.tmpdir();
const nativeId = "019bd450-188a-7000-8000-000000000001";
const threadId = ThreadId.make("019bd450-188a-7000-8000-000000000008");
const projectId = ProjectId.make("vertical-project");
const environmentId = EnvironmentId.make("vertical-environment");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerThreadId = ProviderThreadId.make("vertical-provider-thread");
const nativeSettings = (home: string) => ({
  model: "gpt-5.4",
  reasoningEffort: "ultra" as const,
  approvalPolicy: "on-request" as const,
  sandboxPolicy: { type: "workspaceWrite" as const, writableRoots: [home], networkAccess: false },
});

const peer = Effect.acquireRelease(
  Effect.promise(async () => {
    await NodeFSP.mkdir(evidence, { recursive: true });
    const dir = await NodeFSP.mkdtemp(NodePath.join(evidence, "t3-native-session-"));
    await NodeFSP.chmod(dir, 0o700);
    const home = NodePath.join(dir, "codex");
    await NodeFSP.mkdir(home, { mode: 0o700 });
    for (const name of ["sessions", "thread-writer-locks"])
      await NodeFSP.mkdir(NodePath.join(home, name), { mode: 0o700 });
    const socket = NodePath.join(home, "control.sock");
    const cfg = {
      home,
      socket,
      nativeId,
      settings: nativeSettings(home),
      log: NodePath.join(dir, "peer.ndjson"),
      authority: {
        environmentId,
        threadId,
        providerInstanceId,
        providerSessionId: "synthetic-mcp-session",
      },
    };
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        NodeURL.fileURLToPath(new URL("./testkit/NativeSessionPeer.fixture.mjs", import.meta.url)),
        "app-server",
        JSON.stringify(cfg),
      ],
      {
        cwd: NodePath.resolve(import.meta.dirname, "../.."),
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: home },
      },
    );
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    let pending = "";
    const lines: string[] = [];
    const waiters: Array<(line: string) => void> = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        const waiter = waiters.shift();
        if (waiter) waiter(line);
        else lines.push(line);
      }
    });
    child.stderr.on("data", (bytes) => {
      void NodeFSP.appendFile(NodePath.join(dir, "peer.stderr"), bytes);
    });
    const failed = new Promise<never>((_, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Synthetic peer exited ${code}`)));
    });
    const next = () =>
      Promise.race([
        lines.length
          ? Promise.resolve(lines.shift())
          : new Promise<string>((resolve) => waiters.push(resolve)),
        failed,
      ]);
    try {
      expect(await next()).toBe("ready");
      if (child.pid === undefined) throw new Error("Missing synthetic peer pid");
      const stamp = async (path: string) => {
        const s = await NodeFSP.lstat(path);
        return `${s.dev}:${s.ino}:${s.rdev}`;
      };
      const stat = await NodeFSP.readFile(`/proc/${child.pid}/stat`, "utf8");
      const executable = await NodeFSP.realpath(`/proc/${child.pid}/exe`);
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      if (start === undefined || process.getuid === undefined)
        throw new Error("Linux identity unavailable");
      const boot = (await NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      const binding = {
        home,
        cwd: home,
        nativeId,
        protocolVersion: "0.164.0" as const,
        nativeStores: {
          sessionStore: NodePath.join(home, "sessions"),
          sessionStoreIdentity: await stamp(NodePath.join(home, "sessions")),
          writerLockStore: NodePath.join(home, "thread-writer-locks"),
          writerLockStoreIdentity: await stamp(NodePath.join(home, "thread-writer-locks")),
        },
        transport: {
          kind: "shared-daemon" as const,
          proof: {
            process: { pid: child.pid, start, boot },
            executable,
            codexIdentity: await stamp(executable),
            socket,
            socketIdentity: await stamp(socket),
            rendezvous: socket,
            rendezvousIdentity: await stamp(socket),
            controlIdentity: await stamp(home),
            uid: process.getuid(),
          },
        },
      };
      await NodeFSP.writeFile(NodePath.join(dir, "binding.json"), JSON.stringify(binding, null, 2));
      if (process.env.T3_NATIVE_SESSION_TEST_EVIDENCE_DIR)
        await NodeFSP.writeFile(NodePath.join(evidence, "latest-run.txt"), dir + "\n");
      return { dir, home, binding, child, exited, next, failed };
    } catch (error) {
      child.stdin.end();
      await exited;
      throw error;
    }
  }),
  (fixture) =>
    Effect.promise(async () => {
      fixture.child.stdin.end();
      await fixture.exited;
      await NodeFSP.writeFile(
        NodePath.join(fixture.dir, "peer-exit.json"),
        JSON.stringify(
          {
            pid: fixture.child.pid,
            exitCode: fixture.child.exitCode,
            signalCode: fixture.child.signalCode,
          },
          null,
          2,
        ),
      );
    }),
);

const layers = (fixture: { dir: string; home: string }) => {
  const config = Config.layerTest(fixture.home, NodePath.join(fixture.dir, "t3"));
  const db = Sqlite.layerConfig.pipe(Layer.provide(config));
  const stores = Layer.mergeAll(ProjectionStore.layer, EventStore.layer).pipe(Layer.provide(db));
  const sink = EventSink.layer.pipe(Layer.provide(stores), Layer.provide(db));
  const base = Layer.mergeAll(
    stores,
    sink,
    db,
    config,
    IdAllocator.layer,
    McpProviderSessions.layer,
    ThreadCommandExecutor.layer,
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  );
  const journal = NativeSessionStore.layer.pipe(Layer.provide(base));
  const clientFactory = CodexAdapter.layerAppServerClientFactory.pipe(
    Layer.provide(journal),
    Layer.provide(base),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provide(
      Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
        spawn: () => Effect.die("Unexpected provider process spawn"),
      }),
    ),
  );
  const adapter = ProviderAdapterRegistry.layerFromDrivers({
    drivers: [CodexAdapter.CodexAdapterV2Driver],
    configMap: {
      [providerInstanceId]: {
        driver: ProviderDriverKind.make("codex"),
        displayName: "Synthetic native Codex",
        config: { ...CodexAdapter.CodexAdapterV2Driver.defaultConfig(), homePath: fixture.home },
      },
    },
  }).pipe(Layer.provide(clientFactory), Layer.provide(base));
  const ingestor = ProviderEventIngestor.layer.pipe(
    Layer.provide(base),
    Layer.provide(GitVcsDriver.layer.pipe(Layer.provide(config))),
  );
  const mcp = Layer.succeed(
    McpSessionRegistry.McpSessionRegistry,
    McpSessionRegistry.McpSessionRegistry.of({
      issue: ({ threadId, providerInstanceId }) =>
        Effect.succeed({
          config: {
            endpoint: "http://127.0.0.1:65530/mcp",
            authorizationHeader: "Bearer synthetic-no-authority",
            environmentId,
            threadId,
            providerInstanceId,
            providerSessionId: "synthetic-mcp-session",
            browserToolsAvailable: false,
          },
        }),
      resolve: () => Effect.succeed(undefined),
      touch: () => Effect.void,
      revokeProviderSession: () => Effect.void,
      revokeThread: () => Effect.void,
      revokeAll: Effect.void,
    }),
  );
  const manager = ProviderSessionManager.layerWithOptions().pipe(
    Layer.provide(adapter),
    Layer.provide(ingestor),
    Layer.provide(CommandOutputHub.layer.pipe(Layer.provide(base))),
    Layer.provide(mcp),
    Layer.provide(base),
  );
  return Layer.mergeAll(
    NativeSessionService.layer.pipe(
      Layer.provide(manager),
      Layer.provide(journal),
      Layer.provide(RuntimePolicy.layer),
      Layer.provide(base),
    ),
    base,
    journal,
    manager,
  ).pipe(Layer.provideMerge(NodeServices.layer));
};

const seed = (home: string) =>
  Effect.gen(function* () {
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const thread = OrchestrationV2AppThread.make({
      id: threadId,
      projectId,
      title: "Vertical native fixture",
      providerInstanceId,
      modelSelection: {
        instanceId: providerInstanceId,
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      runtimeMode: "auto",
      interactionMode: "default",
      branch: null,
      worktreePath: home,
      activeProviderThreadId: providerThreadId,
      createdBy: "user",
      creationSource: "web",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledAt: null,
      settledOverride: null,
      lastVisitedAt: null,
      deletedAt: null,
    });
    yield* projection.apply({
      id: EventId.make("seed:thread"),
      threadId,
      occurredAt: now,
      type: "thread.created",
      payload: thread,
    });
    yield* projection.apply({
      id: EventId.make("seed:provider"),
      threadId,
      occurredAt: now,
      type: "provider-thread.updated",
      payload: {
        id: providerThreadId,
        appThreadId: threadId,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId,
        providerSessionId: null,
        ownerNodeId: null,
        nativeThreadRef: { driver: ProviderDriverKind.make("codex"), nativeId, strength: "strong" },
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        contextUsage: null,
        nativeMetadata: null,
        goal: null,
        createdAt: now,
        updatedAt: now,
      },
    });
  });

it.live(
  "preserves native settings through an adopted streamed turn, approval, attachment, refresh and release",
  () =>
    Effect.gen(function* () {
      const fixture = yield* peer;
      yield* Effect.gen(function* () {
        yield* seed(fixture.home);
        const service = yield* NativeSessionService.NativeSessionService;
        const projection = yield* ProjectionStore.ProjectionStoreV2;
        const save = (name: string, value: unknown) =>
          Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(fixture.dir, name + ".json"),
              JSON.stringify(value, null, 2),
            ),
          );
        const adopt = yield* decodeAdopt({
          contractVersion: 1,
          environmentId,
          projectId,
          threadId,
          operationId: "019bd450-188a-7000-8000-000000000002",
          commandId: "019bd450-188a-7000-8000-000000000009",
          expectedEpoch: 0,
          providerInstanceId,
          sourceStopped: {
            evidenceId: "synthetic-source-exit",
            process: {
              pid: 2147483647,
              start: "10",
              boot: fixture.binding.transport.proof.process.boot,
            },
          },
          binding: fixture.binding,
          settings: nativeSettings(fixture.home),
        });
        const adopted = yield* service.adopt(adopt);
        yield* save("adopt-result", adopted);
        expect(adopted).toMatchObject({
          state: "ready",
          controller: { type: "t3", epoch: 1 },
          blockers: [],
          settings: nativeSettings(fixture.home),
          history: {
            authority: "native",
            generation: 1,
            complete: true,
            createdWithCliVersion: "0.163.0",
          },
        });
        const before = yield* projection.getThreadProjection(threadId);
        expect(before.messages.map((m) => m.text)).toEqual([
          "Existing native question",
          "Existing native answer",
        ]);
        expect(before.runs).toEqual([]);
        expect(yield* service.adopt(adopt)).toEqual(adopted);
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const store = yield* NativeSessionStore.NativeSessionStore;
        const native = yield* store.get(threadId);
        if (Option.isNone(native)) throw new Error("Expected enrolled native binding");
        const sessionId = ProviderSessionId.make(`native-session:${native.value.key}`);
        const live = yield* manager.get(sessionId);
        if (Option.isNone(live) || live.value.subscribeEvents === undefined)
          throw new Error("Expected real adopted manager runtime");
        const runtime = live.value;
        const subscription = yield* live.value.subscribeEvents;
        const streamed = yield* subscription.events.pipe(
          Stream.tap((event) =>
            Effect.gen(function* () {
              if (
                event.type === "runtime_request.updated" &&
                event.runtimeRequest.status === "pending"
              ) {
                yield* runtime.respondToRuntimeRequest({
                  requestId: event.runtimeRequest.id,
                  decision: "accept",
                });
              }
              if (
                event.type === "turn_item.updated" &&
                event.turnItem.type === "assistant_message" &&
                event.turnItem.text === "Hello"
              )
                fixture.child.stdin.write("finish\n");
            }),
          ),
          Stream.takeUntil(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
          ),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const attachment = ChatImageAttachment.make({
          type: "image",
          id: "vertical-native-019bd450-188a-7000-8000-000000000007",
          name: "pixel.png",
          mimeType: "image/png",
          sizeBytes: 68,
        });
        const config = yield* Config.ServerConfig;
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment,
        });
        if (attachmentPath === null) throw new Error("Expected valid attachment path");
        const png =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6f8AAAAASUVORK5CYII=";
        const sentText = `New adopted chat question\n\n[Attached image "pixel.png" is saved at: ${attachmentPath}]`;
        yield* Effect.promise(() => NodeFSP.writeFile(attachmentPath, Buffer.from(png, "base64")));
        const provider = before.providerThreads.find((p) => p.id === providerThreadId);
        if (provider === undefined) throw new Error("Expected strong imported provider thread");
        yield* runtime
          .startTurn({
            appThread: before.thread,
            threadId,
            runId: RunId.make("vertical-run"),
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: RunAttemptId.make("vertical-attempt"),
            rootNodeId: NodeId.make("vertical-root"),
            providerThread: provider,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: MessageId.make("vertical-message"),
              text: "New adopted chat question",
              attachments: [attachment],
            },
            modelSelection: before.thread.modelSelection,
            runtimePolicy: {
              runtimeMode: before.thread.runtimeMode,
              interactionMode: "default",
              cwd: fixture.home,
            },
          })
          .pipe(
            Effect.provideService(NativeSessionWriteContext, {
              id: "vertical-run:vertical-attempt",
              operationId: "vertical-run",
              epoch: 1,
            }),
          );
        fixture.child.stdin.write("approve\n");
        const events = yield* Effect.raceFirst(
          Fiber.join(streamed),
          Effect.promise(() => fixture.failed),
        );
        yield* save("streamed-events", events);
        expect(
          events.flatMap((e) =>
            e.type === "turn_item.updated" && e.turnItem.type === "assistant_message"
              ? [e.turnItem.text]
              : [],
          ),
        ).toContain("Hello");
        expect(
          events.filter((e) => e.type === "message.updated").map((e) => e.message.text),
        ).toContain("Hello from adopted chat");
        expect(
          events.filter(
            (e) => e.type === "runtime_request.updated" && e.runtimeRequest.status === "pending",
          ),
        ).toHaveLength(1);
        fixture.child.stdin.write("append\n");
        expect(yield* Effect.promise(fixture.next)).toBe("appended");
        const refresh = {
          contractVersion: 1 as const,
          environmentId,
          projectId,
          threadId,
          operationId: "019bd450-188a-7000-8000-000000000005",
          commandId: CommandId.make("019bd450-188a-7000-8000-000000000010"),
        };
        yield* save("refresh-result", yield* service.refresh(refresh));
        yield* service.refresh({
          ...refresh,
          operationId: "019bd450-188a-7000-8000-000000000006",
          commandId: CommandId.make("019bd450-188a-7000-8000-000000000011"),
        });
        const after = yield* projection.getThreadProjection(threadId);
        yield* save("projection", after);
        expect(after.messages.map((m) => m.text)).toEqual([
          "Existing native question",
          "Existing native answer",
          sentText,
          "Hello from adopted chat",
          "External appended answer",
        ]);
        expect(new Set(after.messages.map((m) => m.id)).size).toBe(5);
        expect(after.runs).toEqual([]);
        const release = yield* decodeRelease({
          ...refresh,
          operationId: "019bd450-188a-7000-8000-000000000003",
          commandId: "019bd450-188a-7000-8000-000000000012",
          expectedEpoch: 1,
          destination: {
            workspaceId: "synthetic-workspace",
            terminalId: "synthetic-terminal",
            process: adopt.sourceStopped.process,
          },
          launchActionId: "019bd450-188a-7000-8000-000000000004",
        });
        const released = yield* service.release(release);
        yield* save("release-result", released);
        expect(released).toMatchObject({
          state: "ready",
          controller: { type: "external", epoch: 2 },
          releaseReceipt: {
            launchActionId: release.launchActionId,
            destination: release.destination,
            nativeId,
          },
        });
        expect(yield* service.release(release)).toEqual(released);
        yield* save("native-effects", yield* store.effects(threadId));
        expect((yield* store.effects(threadId)).every((e) => e.state === "acknowledged")).toBe(
          true,
        );
        const sql = yield* SqlClient.SqlClient;
        yield* save(
          "sqlite-tables",
          yield* sql`SELECT name FROM sqlite_schema WHERE type = 'table'`,
        );
        const journal = yield* sql<{
          event_type: string;
        }>`SELECT * FROM orchestration_events`;
        const receipts = yield* sql<{
          command_id: string;
        }>`SELECT * FROM orchestration_command_receipts`;
        yield* save("sqlite-journal", journal);
        yield* save("sqlite-receipts", receipts);
        expect(journal.some((row) => row.event_type === "native-session.updated")).toBe(true);
        expect(receipts.map((row) => row.command_id).sort()).toEqual(
          [
            adopt.commandId,
            refresh.commandId,
            "019bd450-188a-7000-8000-000000000011",
            release.commandId,
          ].sort(),
        );
        const traffic = (yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(fixture.dir, "peer.ndjson"), "utf8"),
        ))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          traffic.filter(
            (r) =>
              r.direction === "to-peer" &&
              ["thread/start", "thread/inject_items"].includes(r.method),
          ),
        ).toEqual([]);
        const starts = traffic.filter(
          (r) => r.direction === "to-peer" && r.method === "turn/start",
        );
        expect(starts).toHaveLength(1);
        expect(starts[0].params).toMatchObject({
          threadId: nativeId,
          model: "gpt-5.4",
          effort: "ultra",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          collaborationMode: { settings: { model: "gpt-5.4", reasoning_effort: "ultra" } },
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [fixture.home],
            networkAccess: false,
          },
          input: [
            { type: "text", text: sentText },
            { type: "image", url: `data:image/png;base64,${png}` },
          ],
        });
        expect(yield* manager.isLive(sessionId)).toBe(false);
        expect(fixture.child.exitCode).toBe(null);
      }).pipe(Effect.provide(layers(fixture)));
    }),
);
