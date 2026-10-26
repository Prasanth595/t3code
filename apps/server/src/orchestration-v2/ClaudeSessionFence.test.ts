import fixture from "./testkit/claudeSessionContract.fixture.json" with { type: "json" };
import requestFixture from "./testkit/claudeSessionAdopt.fixture.json" with { type: "json" };
import { assert, it } from "@effect/vitest";
import {
  ClaudeSessionAdoptInput,
  ClaudeSessionResult,
  MessageId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Journal from "./ClaudeSessionJournal.ts";
import * as Fence from "./ClaudeSessionFence.ts";

it.effect(
  "persists query intent and uncertain mapped input and fences every stale mutation after release",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fence = yield* Fence.ClaudeSessionFence;
      const request = yield* Schema.decodeUnknownEffect(ClaudeSessionAdoptInput)(
        requestFixture.input,
      );
      const result = yield* Schema.decodeUnknownEffect(ClaudeSessionResult)(fixture);
      if (result.view === null) return yield* Effect.die("missing fixture");
      const row: Journal.ClaudeEnrollment = {
        ...request,
        ownershipGeneration: request.operationId,
        plan: result.view.plan,
        controller: { type: "t3", epoch: 1 },
        sourceTerminal: request.sourceStopped.terminal,
        revision: 1,
        managedWriteRevision: 0,
        view: result.view,
        reservation: null,
        blockers: [],
      };
      yield* sql`INSERT INTO orchestration_v2_claude_sessions VALUES (${row.threadId}, ${row.environmentId}, 'store', ${request.nativeId}, 'transcript', 1, ${JSON.stringify(row)})`;
      const generation = yield* fence.spawnIntent({
        threadId: row.threadId,
        epoch: 1,
        providerSessionId: "provider-session-fixture",
        nativeId: row.plan.nativeId,
      });
      assert.isNotNull(generation);
      if (generation === null) return yield* Effect.die("missing generation");
      yield* fence.updateGeneration(generation.generation, {
        process: request.sourceStopped.terminal.shell,
        state: "owned",
      });
      const message = {
        uuid: "10000000-0000-4000-8000-000000000021",
        messageId: MessageId.make("app-message"),
        turnItemId: TurnItemId.make("app-item"),
      };
      const claim = yield* fence.claim({
        threadId: row.threadId,
        epoch: 1,
        generation: generation.generation,
        kind: "prompt",
        payload: { text: "input" },
        prompt: message,
      });
      assert.isNotNull(claim);
      assert.equal(
        (yield* sql`SELECT * FROM orchestration_v2_claude_writes WHERE state = 'uncertain'`).length,
        1,
      );
      const releasing = { ...row, controller: { type: "releasing", epoch: 2 }, revision: 2 };
      yield* sql`UPDATE orchestration_v2_claude_sessions SET revision = 2, payload_json = ${JSON.stringify(releasing)}`;
      for (const kind of ["prompt", "steer", "approval", "control", "autonomous"] as const) {
        const attempt = yield* fence
          .claim({
            threadId: row.threadId,
            epoch: 1,
            generation: generation.generation,
            kind,
            payload: {},
          })
          .pipe(Effect.result);
        assert.equal(attempt._tag, "Failure");
      }
      assert.equal((yield* fence.generations(row.threadId)).length, 1);
      assert.equal((yield* fence.pending(row.threadId)).length, 1);
      yield* fence.observe(generation.generation, { type: "result", session_id: request.nativeId });
      assert.equal((yield* fence.pending(row.threadId)).length, 1);
      yield* fence.observe(generation.generation, {
        type: "user",
        uuid: message.uuid,
        session_id: request.nativeId,
      });
      assert.equal((yield* fence.pending(row.threadId)).length, 0);
      assert.equal((yield* fence.promptMappings(row.threadId))[0]?.messageId, message.messageId);
    }).pipe(
      Effect.provide(
        Fence.layer.pipe(Layer.provideMerge(Journal.layer), Layer.provideMerge(Sqlite.layerMemory)),
      ),
    ),
);

it.effect(
  "only exact control acknowledgements settle delivery and every unresolved generation survives reconstruction",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fence = yield* Fence.ClaudeSessionFence;
      const request = yield* Schema.decodeUnknownEffect(ClaudeSessionAdoptInput)(
        requestFixture.input,
      );
      const result = yield* Schema.decodeUnknownEffect(ClaudeSessionResult)(fixture);
      if (result.view === null) return yield* Effect.die("missing fixture");
      const row: Journal.ClaudeEnrollment = {
        ...request,
        ownershipGeneration: request.operationId,
        plan: result.view.plan,
        controller: { type: "t3", epoch: 1 },
        sourceTerminal: request.sourceStopped.terminal,
        revision: 1,
        managedWriteRevision: 0,
        view: result.view,
        reservation: null,
        blockers: [],
      };
      yield* sql`INSERT INTO orchestration_v2_claude_sessions VALUES (${row.threadId}, ${row.environmentId}, 'store', ${request.nativeId}, 'transcript', 1, ${JSON.stringify(row)})`;
      const generation = yield* fence.spawnIntent({
        threadId: row.threadId,
        epoch: 1,
        providerSessionId: "fixture",
        nativeId: request.nativeId,
      });
      if (generation === null) return yield* Effect.die("missing generation");
      assert.equal(
        (yield* fence
          .claim({
            threadId: row.threadId,
            epoch: 1,
            generation: generation.generation,
            kind: "control",
            payload: {},
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      yield* fence.updateGeneration(generation.generation, {
        process: request.sourceStopped.terminal.shell,
        state: "owned",
      });
      const control = yield* fence.claim({
        threadId: row.threadId,
        epoch: 1,
        generation: generation.generation,
        kind: "control",
        payload: { method: "setModel" },
      });
      yield* fence.returned(control);
      yield* fence.observe(generation.generation, { type: "result", session_id: request.nativeId });
      assert.equal((yield* fence.pending(row.threadId)).length, 1);
      yield* fence.acknowledge(control);
      assert.equal((yield* fence.pending(row.threadId)).length, 0);
      const approval = yield* fence.claim({
        threadId: row.threadId,
        epoch: 1,
        generation: generation.generation,
        kind: "approval",
        payload: {},
        toolUseId: "approved-tool",
      });
      yield* fence.returned(approval);
      yield* fence.observe(generation.generation, {
        type: "user",
        session_id: request.nativeId,
        message: { content: [{ type: "tool_result", tool_use_id: "other-tool", content: "done" }] },
      });
      assert.equal((yield* fence.pending(row.threadId)).length, 1);
      yield* fence.observe(generation.generation, {
        type: "user",
        session_id: request.nativeId,
        message: {
          content: [{ type: "tool_result", tool_use_id: "approved-tool", content: "done" }],
        },
      });
      assert.equal((yield* fence.pending(row.threadId)).length, 0);
      const reconstructed = yield* Effect.gen(function* () {
        return yield* Fence.ClaudeSessionFence;
      }).pipe(Effect.provide(Layer.fresh(Fence.layer)));
      assert.equal((yield* reconstructed.generations(row.threadId)).length, 1);
      assert.equal(
        (yield* reconstructed
          .spawnIntent({
            threadId: row.threadId,
            epoch: 1,
            providerSessionId: "second",
            nativeId: request.nativeId,
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(
      Effect.provide(
        Fence.layer.pipe(Layer.provideMerge(Journal.layer), Layer.provideMerge(Sqlite.layerMemory)),
      ),
    ),
);
