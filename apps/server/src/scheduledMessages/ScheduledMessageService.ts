import {
  CommandId,
  MessageId,
  ScheduledMessage,
  ScheduledMessageError,
  ScheduledMessageId,
  ThreadId,
  type ScheduledMessageCancelInput,
  type ScheduledMessageCancelResult,
  type ScheduledMessageCreateInput,
  type ScheduledMessageCreateResult,
  type ScheduledMessageListResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";

const MIN_LEAD_MS = 30_000;
const MAX_LEAD_MS = 366 * 24 * 60 * 60 * 1000;
const UNREADABLE_MESSAGE = "The scheduled message could not be read.";
const decodeMessage = Schema.decodeUnknownEffect(ScheduledMessage);
const WorkspaceStrategyJson = Schema.fromJsonString(ScheduledMessage.fields.workspaceStrategy);
const ModelSelectionJson = Schema.fromJsonString(ScheduledMessage.fields.modelSelection);
const decodeWorkspaceStrategy = Schema.decodeUnknownOption(WorkspaceStrategyJson);
const decodeModelSelection = Schema.decodeUnknownOption(ModelSelectionJson);
const encodeWorkspaceStrategy = Schema.encodeSync(WorkspaceStrategyJson);
const encodeModelSelection = Schema.encodeSync(ModelSelectionJson);

interface MessageRow {
  readonly message_id: string;
  readonly prompt: string;
  readonly send_at: string;
  readonly project_id: string;
  readonly thread_id: string | null;
  readonly workspace_strategy_json: string;
  readonly model_selection_json: string;
  readonly runtime_mode: string;
  readonly interaction_mode: string;
  readonly created_by: string;
  readonly creation_source: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly status: string;
  readonly error: string | null;
  readonly sent_thread_id: string | null;
}

const messageError = (message: string, cause?: unknown) =>
  new ScheduledMessageError(cause === undefined ? { message } : { message, cause });
const isMessageError = Schema.is(ScheduledMessageError);

function rowToUnknown(row: MessageRow): unknown | null {
  const workspaceStrategy = decodeWorkspaceStrategy(row.workspace_strategy_json);
  const modelSelection = decodeModelSelection(row.model_selection_json);
  if (Option.isNone(workspaceStrategy) || Option.isNone(modelSelection)) return null;
  return {
    id: row.message_id,
    prompt: row.prompt,
    sendAt: row.send_at,
    projectId: row.project_id,
    threadId: row.thread_id,
    workspaceStrategy: workspaceStrategy.value,
    modelSelection: modelSelection.value,
    runtimeMode: row.runtime_mode,
    interactionMode: row.interaction_mode,
    createdBy: row.created_by,
    creationSource: row.creation_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    error: row.error,
    sentThreadId: row.sent_thread_id,
  };
}

const markUnreadable = (sql: SqlClient.SqlClient, id: string, now: string) => sql`
  UPDATE scheduled_messages
  SET status = 'failed', updated_at = ${now}, error = ${UNREADABLE_MESSAGE}
  WHERE message_id = ${id}
`;

export class ScheduledMessageService extends Context.Service<
  ScheduledMessageService,
  {
    readonly subscribe: () => Stream.Stream<ScheduledMessageListResult, ScheduledMessageError>;
    readonly create: (
      input: ScheduledMessageCreateInput,
    ) => Effect.Effect<ScheduledMessageCreateResult, ScheduledMessageError>;
    readonly cancel: (
      input: ScheduledMessageCancelInput,
    ) => Effect.Effect<ScheduledMessageCancelResult, ScheduledMessageError>;
    readonly dispatchDue: () => Effect.Effect<void, ScheduledMessageError>;
  }
>()("t3/scheduledMessages/ScheduledMessageService") {}

export const layer = Layer.effect(
  ScheduledMessageService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const scheduler = yield* Scheduler.Scheduler;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const changes = yield* PubSub.unbounded<void>();
    const notify = PubSub.publish(changes, undefined);

    const readVisible = Effect.fn("ScheduledMessageService.readVisible")(function* () {
      const rows = yield* sql<MessageRow>`
        SELECT * FROM scheduled_messages
        WHERE status IN ('pending', 'sending', 'failed')
        ORDER BY send_at ASC, message_id ASC
      `;
      const messages: ScheduledMessage[] = [];
      for (const row of rows) {
        const unknown = rowToUnknown(row);
        if (unknown === null) continue;
        const decoded = yield* Effect.result(decodeMessage(unknown));
        if (decoded._tag === "Success") messages.push(decoded.success);
        else
          yield* Effect.logWarning("Skipping undecodable scheduled message", {
            messageId: row.message_id,
            cause: decoded.failure,
          });
      }
      return { messages };
    });

    const create = Effect.fn("ScheduledMessageService.create")(
      function* (input: ScheduledMessageCreateInput) {
        const now = yield* DateTime.now;
        const sendAt = DateTime.make(input.sendAt);
        if (Option.isNone(sendAt)) {
          return yield* messageError("Choose a real time to send this message.");
        }
        const lead = DateTime.toEpochMillis(sendAt.value) - DateTime.toEpochMillis(now);
        if (lead < MIN_LEAD_MS) {
          return yield* messageError("Schedule the message at least 30 seconds from now.");
        }
        if (lead > MAX_LEAD_MS) {
          return yield* messageError("Schedule the message within the next year.");
        }
        const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
        const id = ScheduledMessageId.make(`scheduled-message:${uuid}`);
        const createdAt = DateTime.formatIso(now);
        const message = {
          id,
          prompt: input.prompt,
          sendAt: DateTime.formatIso(sendAt.value),
          projectId: input.projectId,
          threadId: input.threadId ?? null,
          workspaceStrategy: input.workspaceStrategy,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          createdBy: input.createdBy ?? "user",
          creationSource: input.creationSource ?? "web",
          createdAt,
          updatedAt: createdAt,
          status: "pending" as const,
          error: null,
          sentThreadId: null,
        } satisfies ScheduledMessage;
        yield* sql`
          INSERT INTO scheduled_messages (
            message_id, prompt, send_at, project_id, thread_id, workspace_strategy_json,
            model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
            created_at, updated_at, status, error, sent_thread_id
          ) VALUES (
            ${message.id},
            ${message.prompt},
            ${message.sendAt},
            ${message.projectId},
            ${message.threadId},
            ${encodeWorkspaceStrategy(message.workspaceStrategy)},
            ${encodeModelSelection(message.modelSelection)},
            ${message.runtimeMode},
            ${message.interactionMode},
            ${message.createdBy},
            ${message.creationSource},
            ${message.createdAt},
            ${message.updatedAt},
            ${message.status},
            ${message.error},
            ${message.sentThreadId}
          )
        `;
        yield* notify;
        return { message };
      },
      Effect.mapError((cause) =>
        isMessageError(cause) ? cause : messageError("Could not schedule the message.", cause),
      ),
    );

    const cancel = Effect.fn("ScheduledMessageService.cancel")(
      function* (input: ScheduledMessageCancelInput) {
        const now = DateTime.formatIso(yield* DateTime.now);
        const updated = yield* sql<{ message_id: string }>`
          UPDATE scheduled_messages
          SET status = 'cancelled', updated_at = ${now}, error = NULL
          WHERE message_id = ${input.id} AND status = 'pending'
          RETURNING message_id
        `;
        yield* notify;
        return { cancelled: updated.length > 0 };
      },
      Effect.mapError((cause) =>
        isMessageError(cause)
          ? cause
          : messageError("Could not cancel the scheduled message.", cause),
      ),
    );

    const dispatchDue = Effect.fn("ScheduledMessageService.dispatchDue")(
      function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          UPDATE scheduled_messages SET status = 'pending', updated_at = ${now}
          WHERE status = 'sending'
        `;
        const due = yield* sql<{ message_id: string }>`
          SELECT message_id FROM scheduled_messages
          WHERE status = 'pending' AND send_at <= ${now}
          ORDER BY send_at ASC, message_id ASC
        `;
        for (const { message_id: id } of due) {
          const claimed = yield* sql<{ message_id: string }>`
            UPDATE scheduled_messages SET status = 'sending', updated_at = ${now}
            WHERE message_id = ${id} AND status = 'pending'
            RETURNING message_id
          `;
          if (claimed.length === 0) continue;
          const [row] = yield* sql<MessageRow>`
            SELECT * FROM scheduled_messages WHERE message_id = ${id}
          `;
          if (row === undefined) continue;
          const unknown = rowToUnknown(row);
          if (unknown === null) {
            yield* markUnreadable(sql, id, now);
            continue;
          }
          const parsed = yield* Effect.result(decodeMessage(unknown));
          if (parsed._tag === "Failure") {
            yield* markUnreadable(sql, id, now);
            continue;
          }
          const decoded = parsed.success;
          const commandId = CommandId.make(`scheduled-message:${decoded.id}`);
          const messageId = MessageId.make(`scheduled-message:${decoded.id}:message`);
          const sent = yield* Effect.exit(
            Effect.gen(function* () {
              if (decoded.threadId === null) {
                const launched = yield* threadLaunch.launch({
                  commandId,
                  projectId: decoded.projectId,
                  title: decoded.prompt.slice(0, 80),
                  modelSelection: decoded.modelSelection,
                  runtimeMode: decoded.runtimeMode,
                  interactionMode: decoded.interactionMode,
                  workspaceStrategy: decoded.workspaceStrategy,
                  initialMessage: { messageId, text: decoded.prompt, attachments: [] },
                  createdBy: decoded.createdBy,
                  creationSource: decoded.creationSource,
                });
                return launched.threadId;
              }
              const threadId = ThreadId.make(decoded.threadId);
              yield* threadManagement.sendToThread({
                projectId: decoded.projectId,
                commandId,
                threadId,
                messageId,
                text: decoded.prompt,
                attachments: [],
                mode: "queue",
                createdBy: decoded.createdBy,
                creationSource: decoded.creationSource,
              });
              return threadId;
            }),
          );
          const finishedAt = DateTime.formatIso(yield* DateTime.now);
          if (sent._tag === "Success") {
            yield* sql`
              UPDATE scheduled_messages
              SET status = 'sent', updated_at = ${finishedAt}, error = NULL, sent_thread_id = ${sent.value}
              WHERE message_id = ${id}
            `;
          } else {
            yield* sql`
              UPDATE scheduled_messages
              SET status = 'failed', updated_at = ${finishedAt}, error = ${"The message could not be sent."}
              WHERE message_id = ${id}
            `;
          }
        }
        if (due.length > 0) yield* notify;
      },
      Effect.mapError((cause) =>
        isMessageError(cause)
          ? cause
          : messageError("Could not dispatch scheduled messages.", cause),
      ),
    );

    yield* scheduler.register(
      "scheduled-messages",
      dispatchDue().pipe(Effect.ignoreCause({ log: true })),
    );

    const subscribe: ScheduledMessageService["Service"]["subscribe"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(readVisible()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => readVisible())),
          );
        }),
      ).pipe(Stream.mapError((cause) => messageError("Could not list scheduled messages.", cause)));

    return ScheduledMessageService.of({ subscribe, create, cancel, dispatchDue });
  }),
);
