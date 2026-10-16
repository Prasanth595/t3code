import {
  CommandId,
  CoordinationError,
  OrchestrationV2RunJson,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2AppThreadJson,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Coordination from "./CoordinationService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { isLegacyPeerMessage } from "./LegacyPeerQueue.ts";

const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2RunJson));
const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);

export class Retirement extends Context.Service<
  Retirement,
  {
    readonly retire: Effect.Effect<{ retired: number }, CoordinationError>;
  }
>()("t3/coordination/RetireLegacyPeerQueue/Retirement") {}
/** Copy before cancelling. Stable receipts make a crash between the two safe to retry. */
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const board = yield* Coordination.CoordinationService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const retire = Effect.gen(function* () {
    const rows = yield* sql<{
      run_json: string;
      message_json: string;
      thread_json: string;
      project_id: ProjectId;
    }>`
    SELECT r.payload_json AS run_json,m.payload_json AS message_json,t.payload_json AS thread_json,t.project_id
    FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId')
    JOIN orchestration_v2_projection_threads t ON t.thread_id=r.thread_id
    JOIN projection_projects p ON p.project_id=t.project_id AND p.deleted_at IS NULL
    WHERE r.status='queued' AND m.message_id LIKE 'message:mcp:%:thread-send:%' AND t.deleted_at IS NULL
    ORDER BY r.thread_id,r.ordinal`.pipe(
      Effect.mapError(
        (cause) =>
          new CoordinationError({
            reason: "storage",
            message: "Could not read queued peer coordination.",
            cause,
          }),
      ),
    );
    let retired = 0;
    for (const row of rows) {
      const migrated = yield* Effect.gen(function* () {
        const { run, message, thread } = yield* Effect.all({
          run: decodeRun(row.run_json),
          message: decodeMessage(row.message_json),
          thread: decodeThread(row.thread_json),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new CoordinationError({
                reason: "storage",
                message: "Could not decode queued peer coordination.",
                cause,
              }),
          ),
        );
        if (!isLegacyPeerMessage(message, run, thread)) return false;
        yield* board.post({
          commandId: CommandId.make(`coordination:migrate:${message.id}`),
          projectId: row.project_id,
          createdBy: "agent",
          targetThreadId: thread.id,
          topic: `Migrated coordination ${run.ordinal}: ${String(message.senderThreadId).slice(0, 100)}`,
          kind: "update",
          text: message.text
            ? `From ${message.senderThreadId} (moved from the chat queue):\n\n${message.text}`
            : "An earlier agent attachment was moved from the chat queue.",
          attachments: message.attachments,
        });
        yield* orchestrator
          .dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`command:coordination-retire:${run.id}`),
            threadId: thread.id,
            runId: run.id,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new CoordinationError({
                  reason: "storage",
                  message: "Could not cancel migrated peer coordination.",
                  cause,
                }),
            ),
          );
        return true;
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not retire queued peer coordination.", error).pipe(
            Effect.as(false),
          ),
        ),
      );
      if (migrated) retired += 1;
    }
    return { retired };
  });
  return { retire };
});

export const layer = Layer.effect(Retirement, make);
