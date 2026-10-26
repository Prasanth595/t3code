import {
  ClaudeSessionProcess,
  MessageId,
  TurnItemId,
  ThreadId,
  type ClaudeSessionIdentityPlan,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Journal from "./ClaudeSessionJournal.ts";

const Prompt = Schema.Struct({ uuid: Schema.String, messageId: MessageId, turnItemId: TurnItemId });
const Write = Schema.Struct({
  writeId: Schema.String,
  threadId: ThreadId,
  epoch: Schema.Int,
  generation: Schema.String,
  kind: Schema.Literals(["prompt", "steer", "approval", "control", "autonomous"]),
  state: Schema.Literals(["uncertain", "returned", "settled"]),
  payloadDigest: Schema.String,
  prompt: Schema.optionalKey(Prompt),
  toolUseId: Schema.optionalKey(Schema.String),
});
export interface ClaudeWrite extends Schema.Schema.Type<typeof Write> {}
const Generation = Schema.Struct({
  generation: Schema.String,
  threadId: ThreadId,
  epoch: Schema.Int,
  providerSessionId: Schema.String,
  nativeId: Schema.String,
  process: Schema.NullOr(ClaudeSessionProcess),
  state: Schema.Literals(["spawn-intent", "owned", "closing", "exited"]),
  nativeObserved: Schema.Boolean,
  sdkFinalized: Schema.Boolean,
  managerFinalized: Schema.Boolean,
  exitReceiptId: Schema.NullOr(Schema.String),
  background: Schema.Literals(["unknown", "busy", "quiet"]),
});
export interface ClaudeGeneration extends Schema.Schema.Type<typeof Generation> {}
const Claim = Schema.Struct({
  threadId: ThreadId,
  epoch: Schema.Int,
  generation: Schema.String,
  kind: Write.fields.kind,
  payload: Schema.Unknown,
  prompt: Schema.optionalKey(Prompt),
  toolUseId: Schema.optionalKey(Schema.String),
});
export class ClaudeSessionFence extends Context.Service<
  ClaudeSessionFence,
  {
    readonly plan: (
      threadId: ThreadId,
      epoch: number,
    ) => Effect.Effect<ClaudeSessionIdentityPlan | null, Journal.ClaudeJournalError>;
    readonly spawnIntent: (input: {
      threadId: ThreadId;
      epoch: number;
      providerSessionId: string;
      nativeId: string;
    }) => Effect.Effect<ClaudeGeneration | null, Journal.ClaudeJournalError>;
    readonly claim: (
      input: typeof Claim.Type,
    ) => Effect.Effect<ClaudeWrite | null, Journal.ClaudeJournalError>;
    readonly returned: (
      write: ClaudeWrite | null,
    ) => Effect.Effect<void, Journal.ClaudeJournalError>;
    readonly acknowledge: (
      write: ClaudeWrite | null,
    ) => Effect.Effect<void, Journal.ClaudeJournalError>;
    readonly observe: (
      generation: string,
      message: unknown,
    ) => Effect.Effect<void, Journal.ClaudeJournalError>;
    readonly updateGeneration: (
      generation: string,
      patch: Partial<
        Pick<
          ClaudeGeneration,
          | "process"
          | "state"
          | "nativeObserved"
          | "sdkFinalized"
          | "managerFinalized"
          | "exitReceiptId"
          | "background"
        >
      >,
    ) => Effect.Effect<void, Journal.ClaudeJournalError>;
    readonly generations: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ClaudeGeneration>, Journal.ClaudeJournalError>;
    readonly pending: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ClaudeWrite>, Journal.ClaudeJournalError>;
    readonly promptMappings: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<typeof Prompt.Type>, Journal.ClaudeJournalError>;
  }
>()("t3/orchestration-v2/ClaudeSessionFence") {}
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      Schema.is(Journal.ClaudeJournalError)(cause)
        ? cause
        : new Journal.ClaudeJournalError({ code: "runtime-state-unknown", cause }),
    ),
  );
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeWrite = Schema.decodeUnknownEffect(Schema.fromJsonString(Write));
const decodeGeneration = Schema.decodeUnknownEffect(Schema.fromJsonString(Generation));
const Observed = Schema.Struct({
  type: Schema.String,
  session_id: Schema.optionalKey(Schema.String),
  uuid: Schema.optionalKey(Schema.String),
});

export const layer = Layer.effect(
  ClaudeSessionFence,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journal = yield* Journal.ClaudeSessionJournal;
    const admitted = Effect.fn("ClaudeSessionFence.admitted")(function* (
      threadId: ThreadId,
      epoch: number,
    ) {
      const row = yield* journal.get(threadId);
      if (row !== null && (row.controller.type !== "t3" || row.controller.epoch !== epoch))
        return yield* new Journal.ClaudeJournalError({ code: "stale-epoch" });
      return row;
    });
    const advance = Effect.fn("ClaudeSessionFence.advance")(function* (
      row: Journal.ClaudeEnrollment,
    ) {
      const next = {
        ...row,
        revision: row.revision + 1,
        managedWriteRevision: row.managedWriteRevision + 1,
      };
      yield* sql`UPDATE orchestration_v2_claude_sessions SET revision = ${next.revision}, payload_json = ${yield* encode(next)} WHERE thread_id = ${row.threadId} AND revision = ${row.revision}`;
    });
    const plan = Effect.fn("ClaudeSessionFence.plan")(function* (
      threadId: ThreadId,
      epoch: number,
    ) {
      return (yield* admitted(threadId, epoch))?.plan ?? null;
    }, failure);
    const generations = Effect.fn("ClaudeSessionFence.generations")(function* (threadId: ThreadId) {
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_claude_generations WHERE thread_id = ${threadId} ORDER BY rowid`;
      return yield* Effect.forEach(rows, (row) => decodeGeneration(row.payload_json));
    }, failure);
    const updateGeneration = Effect.fn("ClaudeSessionFence.updateGeneration")(
      function* (
        id: string,
        patch: Partial<
          Pick<
            ClaudeGeneration,
            | "process"
            | "state"
            | "nativeObserved"
            | "sdkFinalized"
            | "managerFinalized"
            | "exitReceiptId"
            | "background"
          >
        >,
      ) {
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_claude_generations WHERE generation_id = ${id}`;
        if (rows[0] === undefined)
          return yield* new Journal.ClaudeJournalError({ code: "runtime-state-unknown" });
        const current = yield* decodeGeneration(rows[0].payload_json);
        if (
          current.process !== null &&
          patch.process !== undefined &&
          Journal.claudePayloadHash(current.process) !== Journal.claudePayloadHash(patch.process)
        )
          return yield* new Journal.ClaudeJournalError({ code: "identity-changed" });
        const decoded = yield* Schema.decodeUnknownEffect(Generation)({
          ...current,
          ...patch,
          nativeObserved: current.nativeObserved || patch.nativeObserved === true,
          sdkFinalized: current.sdkFinalized || patch.sdkFinalized === true,
          managerFinalized: current.managerFinalized || patch.managerFinalized === true,
          exitReceiptId: current.exitReceiptId ?? patch.exitReceiptId ?? null,
          state: current.state === "exited" ? "exited" : (patch.state ?? current.state),
        });
        yield* sql`UPDATE orchestration_v2_claude_generations SET state = ${decoded.state}, payload_json = ${yield* encode(decoded)} WHERE generation_id = ${id}`;
      },
      (effect) => effect.pipe(sql.withTransaction, failure),
    );
    const spawnIntent = Effect.fn("ClaudeSessionFence.spawnIntent")(function* (input: {
      threadId: ThreadId;
      epoch: number;
      providerSessionId: string;
      nativeId: string;
    }) {
      return yield* Effect.gen(function* () {
        const row = yield* admitted(input.threadId, input.epoch);
        if (row === null) return null;
        if (row.plan.nativeId !== input.nativeId)
          return yield* new Journal.ClaudeJournalError({ code: "identity-changed" });
        const pending = yield* generations(input.threadId);
        if (
          pending.some(
            (generation) =>
              generation.state !== "exited" ||
              !generation.sdkFinalized ||
              !generation.managerFinalized,
          )
        )
          return yield* new Journal.ClaudeJournalError({ code: "process-exit-unproved" });
        if (
          (yield* sql`SELECT write_id FROM orchestration_v2_claude_writes WHERE thread_id = ${input.threadId} AND state <> 'settled'`)
            .length > 0
        )
          return yield* new Journal.ClaudeJournalError({ code: "managed-delivery-unknown" });
        const value: ClaudeGeneration = {
          ...input,
          generation: yield* randomUuidV4,
          process: null,
          state: "spawn-intent",
          nativeObserved: false,
          sdkFinalized: false,
          managerFinalized: false,
          exitReceiptId: null,
          background: "unknown",
        };
        yield* advance(row);
        yield* sql`INSERT INTO orchestration_v2_claude_generations VALUES (${value.generation}, ${value.threadId}, ${value.epoch}, ${value.state}, ${yield* encode(value)})`;
        return value;
      }).pipe(sql.withTransaction);
    }, failure);
    const claim = Effect.fn("ClaudeSessionFence.claim")(function* (input: typeof Claim.Type) {
      return yield* Effect.gen(function* () {
        const row = yield* admitted(input.threadId, input.epoch);
        if (row === null) return null;
        const own = (yield* generations(input.threadId)).find(
          (generation) =>
            generation.generation === input.generation &&
            generation.epoch === input.epoch &&
            generation.state === "owned" &&
            generation.process !== null,
        );
        if (own === undefined)
          return yield* new Journal.ClaudeJournalError({ code: "runtime-state-unknown" });
        const payloadDigest = Journal.claudePayloadHash(input.payload);
        const unsettled = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_claude_writes WHERE thread_id = ${input.threadId} AND state <> 'settled'`;
        for (const saved of unsettled) {
          const write = yield* decodeWrite(saved.payload_json);
          if (
            (input.prompt !== undefined && write.prompt?.messageId === input.prompt.messageId) ||
            (input.toolUseId !== undefined && write.toolUseId === input.toolUseId) ||
            (input.prompt === undefined &&
              write.kind === input.kind &&
              write.payloadDigest === payloadDigest)
          )
            return yield* new Journal.ClaudeJournalError({ code: "managed-delivery-unknown" });
        }
        const writeId = input.prompt?.uuid ?? (yield* randomUuidV4);
        const existing =
          yield* sql`SELECT write_id FROM orchestration_v2_claude_writes WHERE write_id = ${writeId}`;
        if (existing.length > 0)
          return yield* new Journal.ClaudeJournalError({ code: "managed-delivery-unknown" });
        const value: ClaudeWrite = {
          writeId,
          threadId: input.threadId,
          epoch: input.epoch,
          generation: input.generation,
          kind: input.kind,
          state: "uncertain",
          payloadDigest,
          ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
          ...(input.toolUseId === undefined ? {} : { toolUseId: input.toolUseId }),
        };
        yield* advance(row);
        yield* sql`INSERT INTO orchestration_v2_claude_writes VALUES (${writeId}, ${input.threadId}, ${input.epoch}, 'uncertain', ${yield* encode(value)})`;
        return value;
      }).pipe(sql.withTransaction);
    }, failure);
    const returned = Effect.fn("ClaudeSessionFence.returned")(function* (
      write: ClaudeWrite | null,
    ) {
      if (write === null) return;
      yield* sql`UPDATE orchestration_v2_claude_writes SET state = 'returned', payload_json = ${yield* encode({ ...write, state: "returned" })} WHERE write_id = ${write.writeId} AND state = 'uncertain'`;
    }, failure);
    const acknowledge = Effect.fn("ClaudeSessionFence.acknowledge")(function* (
      write: ClaudeWrite | null,
    ) {
      if (write === null) return;
      yield* sql`UPDATE orchestration_v2_claude_writes SET state = 'settled', payload_json = json_set(payload_json, '$.state', 'settled') WHERE write_id = ${write.writeId} AND thread_id = ${write.threadId} AND epoch = ${write.epoch}`;
    }, failure);
    const writes = Effect.fn("ClaudeSessionFence.writes")(function* (threadId: ThreadId) {
      return yield* Effect.forEach(
        yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_claude_writes WHERE thread_id = ${threadId}`,
        (row) => decodeWrite(row.payload_json),
      );
    }, failure);
    const pending = Effect.fn("ClaudeSessionFence.pending")(function* (threadId: ThreadId) {
      return (yield* writes(threadId)).filter((write) => write.state !== "settled");
    });
    const promptMappings = Effect.fn("ClaudeSessionFence.promptMappings")(function* (
      threadId: ThreadId,
    ) {
      return (yield* writes(threadId)).flatMap((write) =>
        write.prompt === undefined ? [] : [write.prompt],
      );
    });
    const observe = Effect.fn("ClaudeSessionFence.observe")(
      function* (generationId: string, message: unknown) {
        const observed = yield* Schema.decodeUnknownEffect(Observed)(message);
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_claude_generations WHERE generation_id = ${generationId}`;
        if (rows[0] === undefined)
          return yield* new Journal.ClaudeJournalError({ code: "runtime-state-unknown" });
        const generation = yield* decodeGeneration(rows[0].payload_json);
        if (observed.session_id !== generation.nativeId) return;
        yield* updateGeneration(generationId, { nativeObserved: true });
        const toolResults = Schema.decodeUnknownOption(
          Schema.Struct({ message: Schema.Struct({ content: Schema.Array(Schema.Unknown) }) }),
        )(message);
        const toolIds = new Set<string>();
        if (toolResults._tag === "Some")
          for (const block of toolResults.value.message.content) {
            const result = Schema.decodeUnknownOption(
              Schema.Struct({ type: Schema.Literal("tool_result"), tool_use_id: Schema.String }),
            )(block);
            if (result._tag === "Some") toolIds.add(result.value.tool_use_id);
          }
        for (const write of yield* pending(generation.threadId)) {
          if (write.generation !== generationId) continue;
          if (
            (observed.type === "user" &&
              write.prompt !== undefined &&
              write.prompt.uuid === observed.uuid) ||
            (observed.type === "user" &&
              write.toolUseId !== undefined &&
              toolIds.has(write.toolUseId))
          )
            yield* sql`UPDATE orchestration_v2_claude_writes SET state = 'settled', payload_json = ${yield* encode({ ...write, state: "settled" })} WHERE write_id = ${write.writeId}`;
        }
      },
      (effect) => effect.pipe(sql.withTransaction, failure),
    );
    return ClaudeSessionFence.of({
      plan,
      spawnIntent,
      claim,
      returned,
      acknowledge,
      observe,
      updateGeneration,
      generations,
      pending,
      promptMappings,
    });
  }),
);
