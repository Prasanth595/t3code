// @effect-diagnostics nodeBuiltinImport:off -- operation identity needs synchronous SHA-256 of canonical JSON before its SQL transaction.
import {
  ClaudeSessionAdoptInput,
  ClaudeSessionRefreshInput,
  ClaudeSessionReleaseInput,
  ClaudeSessionScope,
  ClaudeSessionIdentityPlan,
  ClaudeSessionView,
  ClaudeSessionTerminal,
  ClaudeSessionResult,
  ClaudeSessionBlocker,
  MessageId,
  TurnItemId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { canonicalClaudeJson } from "../claudeSessionSnapshot.ts";

export const claudePayloadHash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalClaudeJson(value)).digest("hex");
const OperationRequest = Schema.Union([
  ClaudeSessionAdoptInput,
  ClaudeSessionRefreshInput,
  ClaudeSessionReleaseInput,
]);
export const ClaudeOperation = Schema.Struct({
  operationId: ClaudeSessionAdoptInput.fields.operationId,
  threadId: ClaudeSessionScope.fields.threadId,
  kind: Schema.Literals(["adopt", "refresh", "release"]),
  request: OperationRequest,
  requestDigest: Schema.String,
  completed: Schema.Boolean,
  result: Schema.NullOr(ClaudeSessionResult),
});
export interface ClaudeOperation extends Schema.Schema.Type<typeof ClaudeOperation> {}
export const ClaudeEnrollment = Schema.Struct({
  ...ClaudeSessionScope.fields,
  operationId: ClaudeSessionAdoptInput.fields.operationId,
  ownershipGeneration: ClaudeSessionAdoptInput.fields.operationId,
  plan: ClaudeSessionIdentityPlan,
  controller: ClaudeSessionView.fields.controller,
  sourceTerminal: ClaudeSessionTerminal,
  revision: Schema.Int,
  managedWriteRevision: Schema.Int,
  view: Schema.NullOr(ClaudeSessionView),
  reservation: ClaudeSessionResult.fields.reservation,
  blockers: Schema.Array(ClaudeSessionBlocker),
});
export interface ClaudeEnrollment extends Schema.Schema.Type<typeof ClaudeEnrollment> {}
export const ClaudeHistory = Schema.Struct({
  threadId: ThreadId,
  generation: Schema.Int,
  digest: Schema.String,
  items: Schema.Array(
    Schema.Struct({
      uuid: Schema.String,
      messageId: Schema.NullOr(MessageId),
      turnItemId: TurnItemId,
      ordinal: Schema.Int,
      payload: Schema.Unknown,
    }),
  ),
  removedMessageIds: Schema.Array(MessageId),
  removedTurnItemIds: Schema.Array(TurnItemId),
});
export interface ClaudeHistory extends Schema.Schema.Type<typeof ClaudeHistory> {}
export class ClaudeJournalError extends Schema.TaggedError<ClaudeJournalError>()(
  "ClaudeJournalError",
  {
    code: ClaudeSessionBlocker.fields.code,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
export class ClaudeSessionJournal extends Context.Service<
  ClaudeSessionJournal,
  {
    readonly begin: (
      kind: ClaudeOperation["kind"],
      request: ClaudeOperation["request"],
    ) => Effect.Effect<ClaudeOperation, ClaudeJournalError>;
    readonly operation: (
      operationId: string,
    ) => Effect.Effect<ClaudeOperation | null, ClaudeJournalError>;
    readonly get: (
      threadId: ThreadId,
    ) => Effect.Effect<ClaudeEnrollment | null, ClaudeJournalError>;
    readonly history: (
      threadId: ThreadId,
    ) => Effect.Effect<ClaudeHistory | null, ClaudeJournalError>;
    readonly progress: (
      operation: ClaudeOperation,
      result: ClaudeSessionResult,
    ) => Effect.Effect<ClaudeSessionResult, ClaudeJournalError>;
  }
>()("t3/orchestration-v2/ClaudeSessionJournal") {}

const decodeOperation = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeOperation));
const decodeEnrollment = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeEnrollment));
const decodeHistory = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeHistory));
const journalFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      Schema.is(ClaudeJournalError)(cause)
        ? cause
        : new ClaudeJournalError({ code: "runtime-state-unknown", cause }),
    ),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const operation = Effect.fn("ClaudeSessionJournal.operation")(function* (operationId: string) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_claude_operations WHERE operation_id = ${operationId}`;
    return rows[0] === undefined ? null : yield* decodeOperation(rows[0].payload_json);
  }, journalFailure);
  const begin = Effect.fn("ClaudeSessionJournal.begin")(function* (
    kind: ClaudeOperation["kind"],
    request: ClaudeOperation["request"],
  ) {
    const schema =
      kind === "adopt"
        ? ClaudeSessionAdoptInput
        : kind === "release"
          ? ClaudeSessionReleaseInput
          : ClaudeSessionRefreshInput;
    const decoded = yield* Schema.decodeUnknownEffect(schema)(request);
    const requestDigest = claudePayloadHash(decoded);
    return yield* Effect.gen(function* () {
      const existing = yield* operation(decoded.operationId);
      if (existing !== null) {
        if (existing.kind !== kind || existing.requestDigest !== requestDigest)
          return yield* new ClaudeJournalError({ code: "operation-conflict" });
        return existing;
      }
      const value: ClaudeOperation = {
        operationId: decoded.operationId,
        threadId: decoded.threadId,
        kind,
        request: decoded,
        requestDigest,
        completed: false,
        result: null,
      };
      yield* sql`INSERT INTO orchestration_v2_claude_operations (operation_id, thread_id, payload_hash, completed, payload_json) VALUES (${value.operationId}, ${value.threadId}, ${requestDigest}, 0, ${canonicalClaudeJson(value)})`;
      return value;
    }).pipe(sql.withTransaction);
  }, journalFailure);
  const get = Effect.fn("ClaudeSessionJournal.get")(function* (threadId: ThreadId) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_claude_sessions WHERE thread_id = ${threadId}`;
    return rows[0] === undefined ? null : yield* decodeEnrollment(rows[0].payload_json);
  }, journalFailure);
  const history = Effect.fn("ClaudeSessionJournal.history")(function* (threadId: ThreadId) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_claude_history WHERE thread_id = ${threadId}`;
    return rows[0] === undefined ? null : yield* decodeHistory(rows[0].payload_json);
  }, journalFailure);
  const progress = Effect.fn("ClaudeSessionJournal.progress")(function* (
    pending: ClaudeOperation,
    result: ClaudeSessionResult,
  ) {
    return yield* Effect.gen(function* () {
      const current = yield* operation(pending.operationId);
      if (current === null || current.requestDigest !== pending.requestDigest)
        return yield* new ClaudeJournalError({ code: "operation-conflict" });
      if (current.completed && current.result !== null) return current.result;
      yield* sql`UPDATE orchestration_v2_claude_operations SET payload_json = ${canonicalClaudeJson({ ...current, result })} WHERE operation_id = ${pending.operationId} AND completed = 0`;
      return result;
    }).pipe(sql.withTransaction);
  }, journalFailure);
  return ClaudeSessionJournal.of({ begin, operation, get, history, progress });
});

export const layer = Layer.effect(ClaudeSessionJournal, make);
