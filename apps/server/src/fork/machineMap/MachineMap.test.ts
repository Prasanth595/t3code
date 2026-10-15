// @effect-diagnostics nodeBuiltinImport:off - the fake portal needs a plain HTTP server for /enroll and /connect.
/**
 * Fork: machine map. The portal connection against a fake portal: join (MM-204), hello, desired
 * state apply (MM-402, MM-603), no echo and local changes (MM-404), revocation on a level change
 * (MM-1306), commands (MM-501, MM-1402), map tools (MM-805), token rotation (MM-207) and
 * resource samples (MM-1501).
 */
import * as NodeHttp from "node:http";

import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { expect, it } from "@effect/vitest";
import {
  MACHINE_LEVEL_SCOPES,
  type MachineCommand,
  MachineResourcesMessage,
  type MachineStatus,
  MachineToPortal,
  PortalResourcesRequest,
  PortalToMachine,
  type ResourceSample,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as EnvironmentTheme from "../../environmentTheme.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as MachineHost from "./MachineHost.ts";
import * as MachineMap from "./MachineMap.ts";
import { PEER, SELF, arrow, desiredState } from "./MachineMap.testkit.ts";
import * as MachineMapState from "./MachineMapState.ts";
import * as MachineResources from "./MachineResources.ts";
import * as MachineTunnel from "./MachineTunnel.ts";

const decodeMachineMessage = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Union([MachineToPortal, MachineResourcesMessage])),
);
const encodePortalMessage = Schema.encodeSync(
  Schema.fromJsonString(Schema.Union([PortalToMachine, PortalResourcesRequest])),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const STATUS: MachineStatus = {
  t3Version: "1.2.3",
  build: "release",
  hostname: null,
  uptimeSeconds: 0,
  runningTurns: 0,
  waitingThreads: 0,
  scheduledTasks: 0,
  updateWaiting: null,
  cpuPercent: null,
  memoryPercent: null,
  commands: ["stopAllAgents"],
  clients: [],
};

const SAMPLE: ResourceSample = {
  at: "2026-10-13T08:00:00.000Z",
  cpuPercent: 12.5,
  cpuBusyPercent: null,
  cpuStealPercent: null,
  cpuPressurePercent: null,
  cpuCount: 8,
  load: [1, 1, 1],
  memoryUsedBytes: 4,
  memoryTotalBytes: 8,
  swapUsedBytes: null,
  swapTotalBytes: null,
  swapBytesPerSecond: null,
  diskUsedBytes: 1,
  diskTotalBytes: 2,
  netInBytesPerSecond: null,
  netOutBytesPerSecond: null,
  t3: { cpuPercent: null, memoryBytes: 1 },
  agents: null,
  topCpu: null,
  topMemory: null,
  battery: null,
};

/**
 * A portal with `/enroll` and `/connect`. Each machine message lands in `received`, except the
 * resource samples (MM-1501), which land in `samples`.
 */
const startFakePortal = Effect.gen(function* () {
  const received = yield* Queue.unbounded<MachineToPortal>();
  const samples = yield* Queue.unbounded<ResourceSample>();
  const sockets = yield* Queue.unbounded<{
    readonly socket: InstanceType<typeof NodeWS.WebSocket>;
    readonly headers: NodeHttp.IncomingHttpHeaders;
  }>();
  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      const ok = request.url === "/enroll" && body.includes('"good"');
      response.writeHead(ok ? 200 : 403, { "content-type": "application/json" });
      response.end(
        encodeJson(
          ok
            ? { tokenClientId: "mac-token.access", tokenSecret: "secret-1" }
            : { error: "The code expired." },
        ),
      );
    });
  });
  const webSockets = new NodeWS.WebSocketServer({ server, path: "/connect" });
  webSockets.on("connection", (socket, request) => {
    socket.on("message", (data) => {
      const text = String(data);
      // MM-1001: the Durable Object answers this without waking.
      if (text === "ping") return socket.send("pong");
      const message = decodeMachineMessage(text);
      if (message._tag === "resources") Queue.offerUnsafe(samples, message.sample);
      else Queue.offerUnsafe(received, message);
    });
    Queue.offerUnsafe(sockets, { socket, headers: request.headers });
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        for (const client of webSockets.clients) client.terminate();
        webSockets.close();
        server.close(() => resume(Effect.void));
      }),
  );
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Missing portal port");
  return { url: `http://127.0.0.1:${address.port}`, received, samples, sockets };
});

/** The next message of one kind; status messages come and go on their own. */
/** The next status message; other messages are not expected meanwhile. */
const nextStatus = (received: Queue.Queue<MachineToPortal>) =>
  Queue.take(received).pipe(
    Effect.flatMap((message) =>
      message._tag === "status"
        ? Effect.succeed(message.status)
        : Effect.die(new Error(`Expected status, got ${message._tag}`)),
    ),
  );

const nextOf = <Tag extends MachineToPortal["_tag"]>(
  received: Queue.Queue<MachineToPortal>,
  tag: Tag,
): Effect.Effect<Extract<MachineToPortal, { readonly _tag: Tag }>> =>
  Queue.take(received).pipe(
    Effect.flatMap((message) =>
      message._tag === tag
        ? Effect.succeed(message as Extract<MachineToPortal, { readonly _tag: Tag }>)
        : message._tag === "status"
          ? nextOf(received, tag)
          : Effect.die(new Error(`Expected ${tag}, got ${message._tag}`)),
    ),
  );

/** `ServerSettings.layerTest`, with a change stream like the real service. */
const layerSettings = (portalUrl: string) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettings.ServerSettingsService;
      const changes = yield* PubSub.unbounded<ServerSettingsValue>();
      return ServerSettings.ServerSettingsService.of({
        ...base,
        updateSettings: (patch) =>
          base.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(changes, next))),
        streamChanges: Stream.fromPubSub(changes),
      });
    }),
  ).pipe(Layer.provide(ServerSettings.layerTest({ machineMap: { enabled: false, portalUrl } })));

const layerMachineMap = (input: {
  readonly portalUrl: string;
  readonly ran: Ref.Ref<ReadonlyArray<string>>;
  readonly sampled?: Ref.Ref<number>;
}) => {
  const settings = layerSettings(input.portalUrl);
  return MachineMap.layer.pipe(
    Layer.provideMerge(
      MachineMapState.layer.pipe(Layer.provide(settings), Layer.provide(ServerSecretStore.layer)),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(MachineHost.MachineHost)({
          isDesktopCommand: (kind) => kind === "installUpdate" || kind === "reloadWindows",
          supportedCommands: () => ["stopAllAgents"],
          status: (status) =>
            Effect.succeed({
              ...STATUS,
              commands: status.desktopConnected
                ? [...STATUS.commands, "reloadWindows"]
                : STATUS.commands,
            }),
          run: (command: MachineCommand) =>
            Ref.update(input.ran, (ids) => [...ids, command.id]).pipe(
              Effect.as({ ok: true, result: { ran: command.id }, error: null }),
            ),
          restartProcess: Effect.void,
          supervised: false,
        }),
        Layer.mock(MachineTunnel.MachineTunnel)({
          adopt: () => Effect.succeed("unchanged" as const),
          forget: Effect.void,
        }),
        Layer.mock(MachineResources.MachineResources)({
          sample: (input.sampled === undefined
            ? Effect.void
            : Ref.update(input.sampled, (count) => count + 1)
          ).pipe(Effect.as(SAMPLE)),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({ streamDomainEvents: Stream.never }),
        Layer.mock(ScheduledTasks.ScheduledTaskService)({ subscribeList: () => Stream.never }),
        FetchHttpClient.layer,
        NodeSocket.layerWebSocketConstructorWS,
      ),
    ),
    Layer.provideMerge(settings),
    Layer.provideMerge(
      EnvironmentAuth.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ServerEnvironment.layerIdentity),
      ),
    ),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(EnvironmentTheme.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-machine-map-" })),
  );
};

it.layer(NodeServices.layer)("MachineMap", (it) => {
  it.effect("joins, applies the desired state and talks with the portal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const portal = yield* startFakePortal;
        const ran = yield* Ref.make<ReadonlyArray<string>>([]);
        yield* Effect.gen(function* () {
          const machineMap = yield* MachineMap.MachineMap;
          const state = yield* MachineMapState.MachineMapState;
          const settings = yield* ServerSettings.ServerSettingsService;
          const auth = yield* EnvironmentAuth.EnvironmentAuth;

          // MM-204: a refused code changes nothing; a good one saves the token and turns on.
          const refused = yield* machineMap.join({ code: "bad" }).pipe(Effect.flip);
          expect(refused).toMatchObject({ reason: "join-refused", detail: "The code expired." });
          const joined = yield* machineMap.join({ code: "good" });
          expect(joined).toMatchObject({ enabled: true, joined: true, tokenHeaders: null });
          expect((yield* settings.getSettings).machineMap.enabled).toBe(true);

          // MM-1303: one socket with the machine token, then hello.
          const { socket, headers } = yield* Queue.take(portal.sockets);
          expect(headers["cf-access-client-id"]).toBe("mac-token.access");
          expect(headers["cf-access-client-secret"]).toBe("secret-1");
          const hello = yield* nextOf(portal.received, "hello");
          expect(hello).toMatchObject({ protocol: 1, appliedRevision: null, status: STATUS });
          expect(hello.settings.server).toHaveProperty("preferOriginRemote", false);
          expect(hello.settings.server).not.toHaveProperty("machineMap");
          const send = (message: PortalToMachine) =>
            Effect.sync(() => socket.send(encodePortalMessage(message)));

          // MM-402, MM-603: apply, save, confirm. The map's own write is no local change.
          const theme = {
            json: { name: "Ocean", appearance: "dark", canvas: "#001122", accent: "#3388ff" },
            css: null,
          };
          yield* send({
            _tag: "desired",
            state: desiredState({
              revision: 1,
              arrowsIn: [arrow(PEER, SELF, "read")],
              server: {
                preferOriginRemote: true,
                machineMap: { enabled: false },
                sharedThemes: { "ocean-sync": theme },
              },
            }),
          });
          expect(yield* nextOf(portal.received, "applied")).toEqual({
            _tag: "applied",
            revision: 1,
          });
          const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          expect(yield* fs.readDirectory(environmentThemesDir)).toEqual(["ocean-sync.json"]);
          const afterApply = yield* settings.getSettings;
          expect(afterApply.preferOriginRemote).toBe(true);
          // The map never turns its own connection off.
          expect(afterApply.machineMap.enabled).toBe(true);
          expect((yield* state.snapshot).saved.desired?.revision).toBe(1);

          // MM-404: a change made here goes to the portal; nothing else does.
          yield* settings.updateSettings({ branchNamePrefix: "yz" });
          expect(yield* nextOf(portal.received, "localSettings")).toEqual({
            _tag: "localSettings",
            scope: "server",
            values: { branchNamePrefix: "yz" },
          });

          // MM-1306: a lower level ends the sessions of that machine.
          const peerSession = yield* auth.issueSession({
            subject: `machine:${PEER}`,
            scopes: MACHINE_LEVEL_SCOPES.read,
          });
          const ownerSession = yield* auth.issueSession({ subject: "one-time-token" });
          yield* send({
            _tag: "desired",
            state: desiredState({
              revision: 2,
              arrowsIn: [arrow(PEER, SELF, "none")],
              // MM-409: an id that is not a file name in the themes folder is refused.
              server: { sharedThemes: { "../escape": theme } },
            }),
          });
          yield* nextOf(portal.received, "applied");
          expect(yield* fs.exists(`${environmentThemesDir}/../escape.json`)).toBe(false);
          const sessionIds = (yield* auth.listSessions()).map((session) => session.sessionId);
          expect(sessionIds).not.toContain(peerSession.sessionId);
          expect(sessionIds).toContain(ownerSession.sessionId);

          // MM-501: a command runs once, even when the portal sends it again.
          const command = (id: string, input: MachineCommand["input"]): MachineCommand => ({
            id,
            machineId: SELF,
            input,
            delivery: "online",
            actor: { _tag: "portal", reason: "test" },
            status: "delivered",
            createdAt: "2026-10-13T08:00:00.000Z",
            updatedAt: "2026-10-13T08:00:00.000Z",
            expiresAt: "2999-01-01T00:00:00.000Z",
            result: null,
            error: null,
          });
          yield* send({ _tag: "command", command: command("c1", { _tag: "stopAllAgents" }) });
          expect(yield* nextOf(portal.received, "commandResult")).toMatchObject({
            commandId: "c1",
            ok: true,
          });
          yield* send({ _tag: "command", command: command("c1", { _tag: "stopAllAgents" }) });
          yield* send({ _tag: "command", command: command("c2", { _tag: "stopAllAgents" }) });
          expect(yield* nextOf(portal.received, "commandResult")).toMatchObject({
            commandId: "c2",
          });
          expect(yield* Ref.get(ran)).toEqual(["c1", "c2"]);

          // MM-1402: a desktop command waits for the desktop app and its result.
          yield* send({ _tag: "command", command: command("d1", { _tag: "reloadWindows" }) });
          const desktopState = yield* machineMap.clientStates({ desktop: true }).pipe(
            Stream.filter((client) => client.desktopCommands.length > 0),
            Stream.runHead,
          );
          expect(desktopState._tag === "Some" && desktopState.value.desktopCommands[0]?.id).toBe(
            "d1",
          );
          expect(desktopState._tag === "Some" && desktopState.value.tokenHeaders).toEqual({
            "CF-Access-Client-Id": "mac-token.access",
            "CF-Access-Client-Secret": "secret-1",
          });
          const notDesktop = yield* machineMap
            .reportDesktop({}, { desktop: false })
            .pipe(Effect.flip);
          expect(notDesktop.reason).toBe("desktop-only");
          yield* machineMap.reportDesktop(
            { commandResult: { commandId: "d1", ok: true, result: null, error: null } },
            { desktop: true },
          );
          expect(yield* nextOf(portal.received, "commandResult")).toMatchObject({
            commandId: "d1",
            ok: true,
          });
          expect((yield* state.snapshot).saved.desktopCommands).toEqual([]);

          // MM-1001, MM-502: a listening desktop app is a change, sent after the 5 second gap.
          const listening = yield* Deferred.make<void>();
          const desktop = yield* machineMap.clientStates({ desktop: true }).pipe(
            Stream.tap(() => Deferred.succeed(listening, undefined)),
            Stream.runDrain,
            Effect.forkChild,
          );
          yield* Deferred.await(listening);
          yield* TestClock.adjust("5 seconds");
          expect((yield* nextStatus(portal.received)).commands).toContain("reloadWindows");
          yield* Fiber.interrupt(desktop);

          // MM-805: a map tool goes to the portal and returns its answer or refusal.
          const call = yield* machineMap
            .callMapTool({ tool: "machines_read", input: {}, threadId: "t1", threadTitle: "T" })
            .pipe(Effect.forkChild);
          const toolCall = yield* nextOf(portal.received, "toolCall");
          expect(toolCall).toMatchObject({
            tool: "machines_read",
            threadId: "t1",
            threadTitle: "T",
          });
          yield* send({
            _tag: "toolResult",
            requestId: toolCall.requestId,
            ok: true,
            result: { machines: 2 },
            error: null,
          });
          expect(yield* Fiber.join(call)).toEqual({ machines: 2 });
          const refusedCall = yield* machineMap
            .callMapTool({
              tool: "machines_undo",
              input: { revision: 1 },
              threadId: null,
              threadTitle: null,
            })
            .pipe(
              Effect.match({ onFailure: (error) => error, onSuccess: () => null }),
              Effect.forkChild,
            );
          const refusedToolCall = yield* nextOf(portal.received, "toolCall");
          yield* send({
            _tag: "toolResult",
            requestId: refusedToolCall.requestId,
            ok: false,
            result: null,
            error: "The map role of this machine is read.",
          });
          expect(yield* Fiber.join(refusedCall)).toMatchObject({
            reason: "refused",
            detail: "The map role of this machine is read.",
          });

          // MM-207: save the rotated secret, then confirm.
          yield* send({
            _tag: "rotate",
            tokenClientId: "mac-token.access",
            tokenSecret: "secret-2",
          });
          expect(yield* nextOf(portal.received, "rotated")).toEqual({
            _tag: "rotated",
            tokenClientId: "mac-token.access",
          });
          expect((yield* state.snapshot).token?.secret).toBe("secret-2");

          // Leaving turns the map off and forgets the token; the tools then say why they fail.
          const left = yield* machineMap.leave;
          expect(left).toMatchObject({ enabled: false, joined: false, desired: null });
          const offline = yield* machineMap
            .callMapTool({ tool: "machines_read", input: {}, threadId: null, threadTitle: null })
            .pipe(Effect.match({ onFailure: (error) => error.reason, onSuccess: () => null }));
          expect(offline).toBe("not-connected");
        }).pipe(Effect.provide(layerMachineMap({ portalUrl: portal.url, ran })));
      }),
    ),
  );

  it.effect("the Machines panel reads the map, or says why it cannot (MM-1701)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const portal = yield* startFakePortal;
        const ran = yield* Ref.make<ReadonlyArray<string>>([]);
        yield* Effect.gen(function* () {
          const machineMap = yield* MachineMap.MachineMap;
          const state = yield* MachineMapState.MachineMapState;
          expect(yield* machineMap.readPanel).toMatchObject({ _tag: "unavailable", reason: "off" });

          yield* machineMap.join({ code: "good" });
          const { socket } = yield* Queue.take(portal.sockets);
          yield* nextOf(portal.received, "hello");
          const answer = (result: unknown) =>
            Effect.gen(function* () {
              const read = yield* machineMap.readPanel.pipe(Effect.forkChild);
              const toolCall = yield* nextOf(portal.received, "toolCall");
              expect(toolCall).toMatchObject({ tool: "machines_read", threadId: null });
              socket.send(
                encodePortalMessage({
                  _tag: "toolResult",
                  requestId: toolCall.requestId,
                  ok: true,
                  result,
                  error: null,
                }),
              );
              return yield* Fiber.join(read);
            });
          const desired = desiredState({});
          const panel = yield* answer({
            _tag: "read",
            map: {
              revision: 3,
              machines: [desired.self],
              arrows: [],
              settings: { managed: [], shared: { server: {}, client: {} }, overrides: {} },
              presets: [],
            },
            presence: {},
            commands: [],
            history: [{ dropped: true }],
            proposals: [],
            resources: { latest: {}, alerts: [], thresholds: {} },
          });
          expect(panel).toMatchObject({ _tag: "read", map: { revision: 3 } });
          // The panel does not need the history, so it does not cross the socket.
          expect(panel).not.toHaveProperty("history");
          expect(yield* answer({ _tag: "read", map: null })).toMatchObject({
            _tag: "unavailable",
            reason: "unreadable",
          });

          // MM-711: the portal refuses machines_read while paused, so the panel does not ask.
          yield* state.updateSaved((saved) => ({
            ...saved,
            desired: { ...desired, paused: true },
          }));
          expect(yield* machineMap.readPanel).toMatchObject({
            _tag: "unavailable",
            reason: "paused",
          });
        }).pipe(Effect.provide(layerMachineMap({ portalUrl: portal.url, ran })));
      }),
    ),
  );

  it.effect("a removed machine forgets its token and its arrows, and says why (MM-208)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const portal = yield* startFakePortal;
        const ran = yield* Ref.make<ReadonlyArray<string>>([]);
        yield* Effect.gen(function* () {
          const machineMap = yield* MachineMap.MachineMap;
          const state = yield* MachineMapState.MachineMapState;
          const auth = yield* EnvironmentAuth.EnvironmentAuth;

          yield* machineMap.join({ code: "good" });
          const { socket } = yield* Queue.take(portal.sockets);
          yield* nextOf(portal.received, "hello");
          socket.send(
            encodePortalMessage({
              _tag: "desired",
              state: desiredState({ revision: 1, arrowsIn: [arrow(PEER, SELF, "read")] }),
            }),
          );
          yield* nextOf(portal.received, "applied");
          const peerSession = yield* auth.issueSession({
            subject: `machine:${PEER}`,
            scopes: MACHINE_LEVEL_SCOPES.read,
          });

          socket.close(4004, "This machine left the map.");
          const removed = yield* machineMap.clientStates({ desktop: false }).pipe(
            Stream.filter((client) => !client.joined),
            Stream.runHead,
          );
          expect(removed._tag === "Some" && removed.value).toMatchObject({
            enabled: true,
            desired: null,
            connection: {
              status: "not-joined",
              lastError:
                "The portal removed this machine from the map. Join again with a new code.",
            },
          });
          expect((yield* state.snapshot).token).toBeNull();
          const sessionIds = (yield* auth.listSessions()).map((session) => session.sessionId);
          expect(sessionIds).not.toContain(peerSession.sessionId);
        }).pipe(Effect.provide(layerMachineMap({ portalUrl: portal.url, ran })));
      }),
    ),
  );

  it.effect("sends a resource sample on connection, every minute and on request (MM-1501)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const portal = yield* startFakePortal;
        const ran = yield* Ref.make<ReadonlyArray<string>>([]);
        const sampled = yield* Ref.make(0);
        yield* Effect.gen(function* () {
          const machineMap = yield* MachineMap.MachineMap;
          yield* machineMap.join({ code: "good" });
          const { socket } = yield* Queue.take(portal.sockets);
          yield* nextOf(portal.received, "hello");
          expect(yield* Queue.take(portal.samples)).toEqual(SAMPLE);

          // On request, once the 10 second gap passed.
          yield* TestClock.adjust("11 seconds");
          socket.send(encodePortalMessage({ _tag: "sampleResources" }));
          expect(yield* Queue.take(portal.samples)).toEqual(SAMPLE);

          // The minute loop goes on by itself.
          yield* TestClock.adjust("1 minute");
          expect(yield* Queue.take(portal.samples)).toEqual(SAMPLE);
          expect(yield* Ref.get(sampled)).toBe(3);
        }).pipe(Effect.provide(layerMachineMap({ portalUrl: portal.url, ran, sampled })));
      }),
    ),
  );
});
