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

/** Copy before cancelling. Stable receipts make a crash between the two safe to retry. */
export const retire = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const board = yield* Coordination.CoordinationService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const rows = yield* sql<{
    run_json: string;
    message_json: string;
    thread_json: string;
    project_id: ProjectId;
  }>`
    SELECT r.payload_json AS run_json,m.payload_json AS message_json,t.payload_json AS thread_json,t.project_id
    FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId')
    JOIN orchestration_v2_projection_threads t ON t.thread_id=r.thread_id
    WHERE r.status='queued' AND m.message_id LIKE 'message:mcp:%:thread-send:%' AND t.deleted_at IS NULL`;
  let retired = 0;
  for (const row of rows) {
    const run = yield* decodeRun(row.run_json);
    const message = yield* decodeMessage(row.message_json);
    const thread = yield* decodeThread(row.thread_json);
    if (!isLegacyPeerMessage(message, run, thread)) continue;
    yield* board.post({
      commandId: CommandId.make(`coordination:migrate:${message.id}`),
      projectId: row.project_id,
      createdBy: "agent",
      targetThreadId: thread.id,
      topic: `Migrated coordination: ${String(message.senderThreadId).slice(0, 120)}`,
      kind: "update",
      text: message.text
        ? `From ${message.senderThreadId} (moved from the chat queue):\n\n${message.text}`
        : "An earlier agent attachment was moved from the chat queue.",
      attachments: message.attachments,
    });
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make(`command:coordination-retire:${run.id}`),
      threadId: thread.id,
      runId: run.id,
    });
    retired += 1;
  }
  return { retired };
});

export class Retirement extends Context.Service<
  Retirement,
  {
    readonly retire: Effect.Effect<
      { retired: number },
      import("@t3tools/contracts").CoordinationError
    >;
  }
>()("t3/coordination/RetireLegacyPeerQueue/Retirement") {}
export const layer = Layer.effect(
  Retirement,
  Effect.context<
    SqlClient.SqlClient | Coordination.CoordinationService | Orchestrator.OrchestratorV2
  >().pipe(
    Effect.map((context) => ({
      retire: retire.pipe(
        Effect.provideContext(context),
        Effect.mapError(
          (cause) =>
            new CoordinationError({
              reason: "storage",
              message: "Could not migrate pending peer coordination.",
              cause,
            }),
        ),
      ),
    })),
  ),
);
