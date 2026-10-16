import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ThreadId, type CoordinationSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Coordination from "./CoordinationService.ts";

const projectId = ProjectId.make("coordination-project");
const sender = ThreadId.make("coordination-sender");
const recipient = ThreadId.make("coordination-recipient");
const observer = ThreadId.make("coordination-observer");
const layer = Coordination.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Project','/tmp','[]','2026-01-01','2026-01-01')`;
  for (const id of [sender, recipient, observer]) {
    yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${id},${projectId},${id},'codex','full-access','default','2026-01-01','2026-01-01','{"settledAt":null}')`;
  }
});
const post = (key: string, text: string, kind: "update" | "request" | "blocker" = "update") => ({
  commandId: CommandId.make(key),
  projectId,
  senderThreadId: sender,
  targetThreadId: recipient,
  topic: "Deployment",
  kind,
  text,
  createdBy: "agent" as const,
});

it.effect("consolidates status traffic without admitting any chat work", () =>
  Effect.gen(function* () {
    yield* seed;
    const board = yield* Coordination.CoordinationService;
    const sql = yield* SqlClient.SqlClient;
    for (let n = 0; n < 20; n++) yield* board.post(post(`update-${n}`, `phase ${n}`));
    const snapshot = yield* board.read({ projectId, threadId: recipient });
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0]!.text, "phase 19");
    assert.equal(snapshot.entries[0]!.updateCount, 20);
    assert.equal(snapshot.unreadCount, 1);
    assert.deepEqual(yield* sql`SELECT run_id FROM orchestration_v2_projection_runs`, []);
    assert.deepEqual(yield* sql`SELECT message_id FROM orchestration_v2_projection_messages`, []);
    for (const kind of ["dynamic_tool_call", "auth_refresh"]) {
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json)
        VALUES (${kind},${recipient},'node',${kind},'pending','2026-01-01','{}')`;
    }
    assert.equal(snapshot.threads.find((thread) => thread.threadId === recipient)?.status, "idle");
    assert.equal(
      (yield* board.read({ projectId })).threads.find((thread) => thread.threadId === recipient)
        ?.status,
      "idle",
    );
    yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json)
      VALUES ('question',${recipient},'node','user_input','pending','2026-01-01','{}')`;
    assert.equal(
      (yield* board.read({ projectId })).threads.find((thread) => thread.threadId === recipient)
        ?.status,
      "waiting_for_user",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("correlates replies, bounds open requests and rejects changed retry payloads", () =>
  Effect.gen(function* () {
    yield* seed;
    const board = yield* Coordination.CoordinationService;
    const request = yield* board.post(post("request", "Can you release?", "request"));
    assert.equal((yield* board.read({ projectId })).entries[0]?.id, request.id);
    assert.deepEqual((yield* board.read({ projectId, threadId: observer })).entries, []);
    assert.equal(
      (yield* board
        .post({
          ...post("observer-reply", "Uninvited reply"),
          senderThreadId: observer,
          replyToId: request.id,
        })
        .pipe(Effect.flip)).reason,
      "forbidden",
    );
    assert.equal(
      (yield* board
        .resolve({
          projectId,
          entryId: request.id,
          status: "resolved",
          actorThreadId: observer,
        })
        .pipe(Effect.flip)).reason,
      "forbidden",
    );
    assert.deepEqual(yield* board.post(post("request", "Can you release?", "request")), request);
    assert.equal(
      (yield* board.post(post("another", "Again?", "request")).pipe(Effect.flip)).reason,
      "conflict",
    );
    assert.equal(
      (yield* board.post(post("request", "Changed", "request")).pipe(Effect.flip)).reason,
      "conflict",
    );
    const reply = yield* board.post({
      ...post("reply", "Release finished."),
      senderThreadId: recipient,
      replyToId: request.id,
    });
    assert.equal(reply.replyToId, request.id);
    assert.equal(reply.targetThreadId, sender);
    assert.equal((yield* board.get(projectId, request.id)).status, "open");
    yield* board.resolve({
      projectId,
      entryId: request.id,
      status: "resolved",
      actorThreadId: recipient,
    });
    assert.equal((yield* board.get(projectId, reply.id)).status, "resolved");
    assert.equal((yield* board.read({ projectId, threadId: sender })).unreadCount, 0);
    assert.equal(yield* board.context(sender), "");
    assert.equal(
      (yield* board
        .post({ ...post("late", "More chatter"), replyToId: request.id })
        .pipe(Effect.flip)).reason,
      "conflict",
    );
    yield* board.post(post("new-request", "A new release?", "request"));
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps new activity unread after an older acknowledgment and pauses context only", () =>
  Effect.gen(function* () {
    yield* seed;
    const board = yield* Coordination.CoordinationService;
    const first = yield* board.post(post("first", "Prepared."));
    assert.include(yield* board.toolNotice(recipient), "Prepared.");
    assert.equal(yield* board.toolNotice(recipient), "");
    yield* board.post(post("second", "Deploying."));
    yield* board.preferences({ projectId, threadId: recipient, readRevision: first.revision });
    assert.equal((yield* board.read({ projectId, threadId: recipient })).unreadCount, 1);
    yield* board.preferences({ projectId, threadId: recipient, paused: true });
    assert.equal(yield* board.context(recipient), "");
    assert.equal(
      (yield* board.read({ projectId, threadId: recipient })).entries[0]!.text,
      "Deploying.",
    );
    yield* board.preferences({ projectId, threadId: recipient, paused: false });
    assert.include(yield* board.context(recipient), "Deploying.");
    yield* board.preferences({ projectId, threadId: recipient, mutedTopics: ["Deployment"] });
    assert.equal((yield* board.read({ projectId, threadId: recipient })).unreadCount, 0);
    assert.equal((yield* board.read({ projectId, threadId: sender })).entries.length, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("streams project updates and closes stale requests without starting idle threads", () =>
  Effect.gen(function* () {
    yield* seed;
    const board = yield* Coordination.CoordinationService;
    const snapshots = yield* Queue.unbounded<CoordinationSnapshot>();
    yield* board.subscribe({ projectId, threadId: recipient }).pipe(
      Stream.runForEach((snapshot) => Queue.offer(snapshots, snapshot)),
      Effect.forkScoped,
    );
    assert.equal((yield* Queue.take(snapshots)).entries.length, 0);
    const update = yield* board.post({
      ...post("global", "Deployment started"),
      targetThreadId: undefined,
    });
    const live = yield* Queue.take(snapshots);
    assert.equal(live.entries[0]!.id, update.id);
    assert.equal(live.unreadCount, 1);
    yield* board.preferences({ projectId, threadId: recipient, mutedTopics: ["Deployment"] });
    assert.equal((yield* board.read({ projectId, threadId: recipient })).unreadCount, 0);
    const request = yield* board.post({
      ...post("expires", "Please check the release", "blocker"),
      topic: "Release",
    });
    const reply = yield* board.post({
      ...post("expiry-reply", "Checking"),
      replyToId: request.id,
      senderThreadId: recipient,
    });
    yield* TestClock.adjust("25 hours");
    assert.equal(yield* board.context(recipient), "");
    assert.equal((yield* board.get(projectId, request.id)).status, "expired");
    assert.equal((yield* board.get(projectId, reply.id)).status, "expired");
    assert.equal((yield* board.read({ projectId, threadId: recipient })).unreadCount, 0);
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(yield* sql`SELECT run_id FROM orchestration_v2_projection_runs`, []);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "preserves preferences and replies across a service restart and rejects foreign membership",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const board = yield* Coordination.CoordinationService;
      const first = yield* board.post(post("first", "Prepared."));
      yield* board.preferences({
        projectId,
        threadId: recipient,
        readRevision: first.revision,
        mutedTopics: ["Deployment"],
      });
      const restarted = yield* Effect.scoped(Layer.build(Coordination.layer)).pipe(
        Effect.map((context) => Context.get(context, Coordination.CoordinationService)),
      );
      assert.equal(
        (yield* restarted.read({ projectId, threadId: recipient })).preferences.readRevision,
        first.revision,
      );
      assert.equal(yield* restarted.context(recipient), "");
      assert.equal(
        (yield* board
          .post({
            ...post("foreign", "Wrong recipient"),
            targetThreadId: ThreadId.make("another-project"),
          })
          .pipe(Effect.flip)).reason,
        "not_found",
      );
    }).pipe(Effect.provide(layer)),
);
