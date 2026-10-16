// Offline only: real sqlite + orchestration receipts; no provider worker is started.
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Sign synthetic Standard Webhooks fixtures without credentials or network.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Harness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as Inbox from "./BridgeInbox.ts";
import * as Source from "./BridgeInboxSource.ts";

const config = {
  owner: "fixture-owner",
  mcpUrl: "https://bridge.invalid/mcp",
  replayFrom: "2026-10-15T00:00:00.000Z",
  bindings: [
    {
      target: "fixture-m1",
      workstream: "fixture-m1-agent-computer",
      environmentId: "fixture-env",
      projectId: "fixture-project",
      threadId: "fixture-thread",
    },
  ],
  subscription: {
    id: "fixture-sub",
    active: true,
    eligibleFrom: "2026-10-15T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
};
const secret = "whsec_" + Buffer.from("offline-fixture-secret-32-bytes!!").toString("base64");
const adapter = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process is permitted"),
} as ProviderAdapterV2Shape;
const db = Sqlite.layerMemory;
const infra = Harness.layerWithRegistry(
  { name: "bridge-inbox-fixture" },
  ProviderRegistry.layerFromAdapters([adapter]),
  { databaseLayer: db, runEffectWorker: false },
);
const threads = ThreadManagement.layer.pipe(Layer.provideMerge(infra));
const dependencies = Layer.mergeAll(
  threads,
  db,
  Layer.succeed(Source.BridgeInboxSource, {
    readPage: () => Effect.die("Use explicit offline fixture pages"),
  }),
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("fixture-env")),
  }),
);
const serviceLayer = (value: typeof config | null = config) =>
  Inbox.layerWithConfig(value, { webhookSecret: secret }).pipe(Layer.provideMerge(dependencies));
const event = (id: string, overrides = {}) => ({
  eventId: id,
  name: "message.created",
  timestamp: "2026-10-15T01:00:00.000Z",
  cursor: null,
  data: {
    target: "fixture-m1",
    workstream_id: "fixture-m1-agent-computer",
    text: "Fixture informational observation",
    source: "mcp",
    sender_id: "fixture-agent",
    source_message_id: id,
    authority: "agent",
  },
  ...overrides,
});
const encodeFixture = (value: unknown) => JSON.stringify(value);
const callback = (value: ReturnType<typeof event>) =>
  Effect.gen(function* () {
    const inbox = yield* Inbox.BridgeInbox;
    const now = yield* DateTime.now;
    const body = encodeFixture(value);
    const timestamp = String(Math.floor(DateTime.toEpochMillis(now) / 1000));
    const signature = NodeCrypto.createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
      .update(`${value.eventId}.${timestamp}.${body}`)
      .digest("base64");
    return yield* inbox.receiveCallback(body, {
      "webhook-id": value.eventId,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
      "x-mcp-subscription-id": "fixture-sub",
    });
  });
const createThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("fixture-create"),
    threadId: ThreadId.make("fixture-thread"),
    projectId: ProjectId.make("fixture-project"),
    title: "Fixture inbox",
    modelSelection: { instanceId: adapter.instanceId, model: "gpt-6.1-sol" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});
const messages = Effect.gen(function* () {
  const threadService = yield* ThreadManagement.ThreadManagementService;
  return (yield* threadService.getThreadProjection(ThreadId.make("fixture-thread"))).messages;
});

it.effect(
  "holds A when the route is unavailable, retains it beside B, and restores both to the pinned thread",
  () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.BridgeInbox;
      expect(yield* callback(event("evt_A"))).toMatchObject({
        status: 202,
        body: { eventId: "evt_A" },
      });
      yield* inbox.drain;
      expect((yield* inbox.status).rows).toMatchObject([
        { event_id: "evt_A", status: "pending", reason: "thread_unavailable" },
      ]);
      yield* inbox.ingestPage(null, {
        events: [event("evt_B")],
        cursor: "opaque:page-1",
        has_more: false,
      });
      yield* createThread;
      yield* inbox.drain;
      expect((yield* messages).map((m) => m.createdBy)).toEqual(["agent", "agent"]);
      expect(
        (yield* messages).every(
          (m) => m.text.includes("INFORMATIONAL") && m.text.includes("authority=agent"),
        ),
      ).toBe(true);
      expect((yield* inbox.status).rows.map((r) => r.status)).toEqual(["delivered", "delivered"]);
    }).pipe(Effect.provide(serviceLayer())),
);

it.effect(
  "restarts after T3 commit before inbox ACK and replays A twice plus a distinct older event on the same cursor",
  () =>
    Effect.gen(function* () {
      yield* createThread;
      const inbox = yield* Inbox.BridgeInbox;
      const sql = yield* SqlClient.SqlClient;
      yield* callback(event("evt_A"));
      // Fail only the local acknowledgement. The real T3 transaction has already committed.
      yield* sql`CREATE TRIGGER fixture_crash BEFORE UPDATE OF status ON bridge_inbox WHEN NEW.status = 'delivered' BEGIN SELECT RAISE(ABORT, 'fixture crash after T3 commit'); END`;
      yield* inbox.drain.pipe(Effect.ignore);
      expect(yield* messages).toHaveLength(1);
      yield* sql`DROP TRIGGER fixture_crash`;
      // Construct a fresh service on the same durable SQL/orchestrator, as after restart.
      const restarted = yield* Inbox.BridgeInbox.pipe(
        Effect.provide(Inbox.layerWithConfig(config, { webhookSecret: secret })),
      );
      yield* restarted.ingestPage(null, {
        events: [
          event("evt_A"),
          event("evt_A"),
          event("evt_older", { timestamp: "2026-10-15T00:30:00.000Z" }),
        ],
        cursor: "opaque:shared",
        has_more: false,
      });
      yield* restarted.drain;
      expect(yield* messages).toHaveLength(2);
      const receipts = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM orchestration_command_receipts WHERE command_id LIKE 'bridge-inbox:%'`;
      expect(receipts[0]?.count).toBe(2);
      expect((yield* restarted.status).rows.every((r) => r.status === "delivered")).toBe(true);
    }).pipe(Effect.provide(serviceLayer())),
);

it.effect(
  "commits empty filtered pages, recovers arbitrarily old late arrivals, and rolls back the cursor with intake failure",
  () =>
    Effect.gen(function* () {
      yield* createThread;
      const inbox = yield* Inbox.BridgeInbox;
      const sql = yield* SqlClient.SqlClient;
      yield* inbox.ingestPage(null, {
        events: [{ eventId: "other", name: "workstream.updated" }],
        cursor: "opaque:completed",
        has_more: false,
      });
      expect((yield* inbox.status).cursor).toBe("opaque:completed");
      yield* sql`CREATE TRIGGER fixture_no_insert BEFORE INSERT ON bridge_inbox BEGIN SELECT RAISE(ABORT, 'disk failure'); END`;
      yield* inbox
        .ingestPage("opaque:completed", {
          events: [event("evt_late")],
          cursor: "opaque:new",
          has_more: false,
        })
        .pipe(Effect.ignore);
      expect((yield* inbox.status).cursor).toBe("opaque:completed");
      yield* sql`DROP TRIGGER fixture_no_insert`;
      for (const [previous, cursor, id, timestamp] of [
        ["opaque:completed", "opaque:overlap", "evt_late", "2026-10-15T01:02:00.000Z"],
        ["opaque:overlap", "opaque:history", "evt_old_late", "2026-10-15T00:01:00.000Z"],
      ]) {
        yield* inbox.ingestPage(previous!, {
          events: [event(id!, { timestamp })],
          cursor: cursor!,
          has_more: true,
        });
        yield* inbox.drain;
      }
      expect(yield* messages).toHaveLength(2);
    }).pipe(Effect.provide(serviceLayer())),
);

it.effect(
  "holds unmatched routes, rejects foreign owners and pre-activation callbacks, and never rebinds pending rows",
  () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.BridgeInbox;
      yield* callback(event("evt_unknown", { data: { ...event("x").data, target: "unknown" } }));
      expect((yield* inbox.status).rows[0]).toMatchObject({
        status: "pending",
        reason: "unbound_route",
      });
      expect(yield* callback(event("evt_foreign", { owner: "wrong-owner" }))).toMatchObject({
        status: 403,
      });
      expect(
        yield* callback(event("evt_early", { timestamp: "2026-10-14T00:00:00.000Z" })),
      ).toMatchObject({ status: 409 });
      yield* callback(event("evt_pinned"));
      const changed = {
        ...config,
        bindings: [{ ...config.bindings[0]!, threadId: "replacement-thread" }],
      };
      const replacement = yield* Inbox.BridgeInbox.pipe(
        Effect.provide(Inbox.layerWithConfig(changed, { webhookSecret: secret })),
      );
      yield* replacement.drain;
      expect(
        (yield* replacement.status).rows.find((r) => r.event_id === "evt_pinned"),
      ).toMatchObject({ status: "pending", reason: "binding_changed" });
    }).pipe(Effect.provide(serviceLayer())),
);

it.effect(
  "is inert without configuration and refuses an invalid signature before persistence",
  () =>
    Effect.gen(function* () {
      const disabled = yield* Inbox.BridgeInbox.pipe(Effect.provide(Inbox.layerWithConfig(null)));
      expect(yield* disabled.receiveCallback(encodeFixture(event("evt_A")), {})).toMatchObject({
        status: 404,
      });
      const inbox = yield* Inbox.BridgeInbox;
      expect(yield* inbox.receiveCallback(encodeFixture(event("evt_A")), {})).toMatchObject({
        status: 401,
      });
      expect((yield* inbox.status).rows).toEqual([]);
    }).pipe(Effect.provide(serviceLayer())),
);

it.effect(
  "fences concurrent dispatchers and recovers an expired lease without a second T3 message",
  () =>
    Effect.gen(function* () {
      yield* createThread;
      yield* callback(event("evt_A"));
      const real = yield* ThreadManagement.ThreadManagementService;
      const committed = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const blocked = yield* Inbox.BridgeInbox.pipe(
        Effect.provide(
          Inbox.layerWithConfig(config, { webhookSecret: secret }).pipe(
            Layer.provide(
              Layer.succeed(ThreadManagement.ThreadManagementService, {
                ...real,
                sendToThread: (input) =>
                  real.sendToThread(input).pipe(
                    Effect.tap(() => Deferred.succeed(committed, undefined)),
                    Effect.tap(() => Deferred.await(release)),
                  ),
              }),
            ),
          ),
        ),
      );
      const running = yield* blocked.drain.pipe(Effect.forkChild);
      yield* Deferred.await(committed);
      const other = yield* Inbox.BridgeInbox;
      yield* other.drain;
      expect((yield* other.status).rows[0]?.status).toBe("pending");
      yield* TestClock.adjust(60_001);
      yield* other.drain;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);
      expect(yield* messages).toHaveLength(1);
      expect((yield* other.status).rows[0]?.status).toBe("delivered");
    }).pipe(Effect.provide(serviceLayer())),
);

it.effect(
  "rejects inactive, expired and pre-activation callbacks without claiming thread delivery; explicit pull backfill remains independent",
  () =>
    Effect.gen(function* () {
      for (const [subscription, reason] of [
        [{ ...config.subscription, active: false }, "subscription_inactive"],
        [{ ...config.subscription, expiresAt: "1970-01-01T00:00:00.000Z" }, "subscription_expired"],
        [{ ...config.subscription, eligibleFrom: "2026-10-15T01:01:00.000Z" }, "pre_activation"],
      ] as const) {
        const overridden = Inbox.layerWithConfig(
          { ...config, subscription },
          { webhookSecret: secret },
        );
        expect(
          yield* callback(event("evt_activation")).pipe(Effect.provide(overridden)),
        ).toMatchObject({ status: 409, body: { error: reason } });
      }
      const inbox = yield* Inbox.BridgeInbox;
      expect((yield* inbox.status).rows).toHaveLength(0);
      // A terminal callback failure does not reset subscription state. Explicit replayFrom
      // authorizes this independent pull backfill; no callback ACK is fabricated.
      yield* createThread;
      yield* inbox.ingestPage(null, {
        events: [event("evt_activation")],
        cursor: "opaque:backfill",
        has_more: false,
      });
      yield* inbox.drain;
      expect(yield* messages).toHaveLength(1);
    }).pipe(Effect.provide(serviceLayer())),
);

it.effect(
  "holds archived threads and wrong workstreams, and refuses owner-authority payloads",
  () =>
    Effect.gen(function* () {
      yield* createThread;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("fixture-archive"),
        threadId: ThreadId.make("fixture-thread"),
      });
      const inbox = yield* Inbox.BridgeInbox;
      yield* callback(event("evt_archived"));
      yield* callback(
        event("evt_wrong_workstream", {
          data: { ...event("x").data, workstream_id: "other-stream" },
        }),
      );
      expect(
        yield* callback(
          event("evt_owner_authority", { data: { ...event("x").data, authority: "owner" } }),
        ),
      ).toMatchObject({ status: 409, body: { error: "unsupported_authority" } });
      yield* inbox.drain;
      expect(yield* messages).toHaveLength(0);
      expect((yield* inbox.status).rows.map((r) => r.reason)).toEqual([
        "thread_archived",
        "unbound_route",
      ]);
    }).pipe(Effect.provide(serviceLayer())),
);

it.effect(
  "returns no callback 2xx when inbox persistence fails and rejects changed content under an accepted eventId",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER fixture_disk_failure BEFORE INSERT ON bridge_inbox BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END`;
      expect((yield* callback(event("evt_A")).pipe(Effect.result))._tag).toBe("Failure");
      yield* sql`DROP TRIGGER fixture_disk_failure`;
      expect(yield* callback(event("evt_A"))).toMatchObject({ status: 202 });
      expect(
        (yield* callback(
          event("evt_A", { data: { ...event("evt_A").data, text: "Changed content" } }),
        ).pipe(Effect.result))._tag,
      ).toBe("Failure");
      const inbox = yield* Inbox.BridgeInbox;
      expect((yield* inbox.status).rows).toHaveLength(1);
    }).pipe(Effect.provide(serviceLayer())),
);

it.effect(
  "pulls successive opaque overlap/history pages into durable rows, including an empty filtered page",
  () =>
    Effect.gen(function* () {
      yield* createThread;
      const pages = [
        {
          previous: null,
          page: {
            events: [{ name: "workstream.updated" }],
            cursor: "opaque:completed",
            has_more: false,
          },
        },
        {
          previous: "opaque:completed",
          page: { events: [event("evt_recent_late")], cursor: "opaque:overlap", has_more: true },
        },
        {
          previous: "opaque:overlap",
          page: {
            events: [
              event("evt_recent_late"),
              event("evt_history_late", { timestamp: "2026-10-15T00:00:01.000Z" }),
            ],
            cursor: "opaque:full-history",
            has_more: false,
          },
        },
      ];
      let index = 0;
      const pulling = yield* Inbox.BridgeInbox.pipe(
        Effect.provide(
          Inbox.layerWithConfig(config).pipe(
            Layer.provide(
              Layer.succeed(Source.BridgeInboxSource, {
                readPage: (previous) =>
                  Effect.sync(() => {
                    const fixture = pages[index++]!;
                    expect(previous).toBe(fixture.previous);
                    return fixture.page;
                  }),
              }),
            ),
          ),
        ),
      );
      yield* pulling.pull;
      expect((yield* pulling.status).cursor).toBe("opaque:completed");
      yield* pulling.pull;
      yield* pulling.drain;
      yield* pulling.pull;
      yield* pulling.drain;
      expect(yield* messages).toHaveLength(2);
      expect((yield* pulling.status).cursor).toBe("opaque:full-history");
    }).pipe(Effect.provide(serviceLayer())),
);
