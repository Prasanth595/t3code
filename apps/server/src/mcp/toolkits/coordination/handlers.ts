import * as CoordinationIntake from "../../../coordination/CoordinationIntake.ts";
import {
  CommandId,
  OrchestratorMcpFailure,
  type CoordinationError,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Coordination from "../../../coordination/CoordinationService.ts";
import * as Access from "../../McpToolAccess.ts";
import { readCaller, newCommandId } from "../../threadAccess.ts";
import { CoordinationToolkit } from "./tools.ts";
const context = (requested?: ProjectId) =>
  Effect.gen(function* () {
    const caller = yield* readCaller();
    const projectId = requested ?? caller.caller?.projectId;
    if (projectId === undefined)
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "Pass projectId outside a T3 thread.",
      });
    if (caller.caller !== undefined && projectId !== caller.caller.projectId)
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Project coordination stays within this thread's project.",
      });
    return { ...caller, projectId, service: yield* Coordination.CoordinationService };
  });
const commandId = (callerId: string | undefined, request?: string) =>
  request === undefined
    ? newCommandId()
    : Effect.succeed(CommandId.make(`coordination:${callerId ?? "client"}:${request}`));
const failure = (error: CoordinationError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "forbidden"
        ? "capability_denied"
        : error.reason === "not_found"
          ? "thread_not_found"
          : error.reason === "storage"
            ? "orchestration_error"
            : "invalid_request",
    message: error.message,
  });
export const layer = Access.toLayer(CoordinationToolkit, {
  coordination_read: Access.reads((input) =>
    Effect.gen(function* () {
      const { service, caller, projectId } = yield* context(input.projectId);
      const snapshot = yield* service
        .read({
          projectId,
          ...(input.projectWide || caller === undefined ? {} : { threadId: caller.id }),
          limit: input.limit ?? 10,
          ...(input.beforeRevision === undefined ? {} : { beforeRevision: input.beforeRevision }),
        })
        .pipe(Effect.mapError(failure));
      return {
        ...snapshot,
        entries: snapshot.entries.map((entry) => ({
          ...entry,
          text:
            entry.text.length > 1200
              ? entry.text.slice(0, 1200) + "\n[truncated; open Activity for the full post]"
              : entry.text,
        })),
      };
    }),
  ),
  coordination_post: Access.writes((input) =>
    Effect.gen(function* () {
      const { caller, scope, projectId } = yield* context(input.projectId);
      const intake = yield* CoordinationIntake.CoordinationIntake;
      return yield* intake
        .post({
          ...input,
          projectId,
          commandId: yield* commandId(caller?.id ?? scope.requestNamespace, input.clientRequestId),
          createdBy: caller === undefined ? "user" : "agent",
          ...(caller === undefined ? {} : { senderThreadId: caller.id }),
        })
        .pipe(Effect.mapError(failure));
    }),
  ),
  coordination_reply: Access.writes((input) =>
    Effect.gen(function* () {
      const { caller, scope, projectId } = yield* context(input.projectId);
      const intake = yield* CoordinationIntake.CoordinationIntake;
      return yield* intake
        .post({
          projectId,
          commandId: yield* commandId(caller?.id ?? scope.requestNamespace, input.clientRequestId),
          createdBy: caller === undefined ? "user" : "agent",
          ...(caller === undefined ? {} : { senderThreadId: caller.id }),
          replyToId: input.entryId,
          topic: "reply",
          kind: "update",
          text: input.text,
          ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
        })
        .pipe(Effect.mapError(failure));
    }),
  ),
  coordination_resolve: Access.writes((input) =>
    Effect.gen(function* () {
      const { service, caller, projectId } = yield* context(input.projectId);
      return yield* service
        .resolve({
          projectId,
          entryId: input.entryId,
          status: input.status,
          ...(caller === undefined ? {} : { actorThreadId: caller.id }),
        })
        .pipe(Effect.mapError(failure));
    }),
  ),
  coordination_preferences: Access.writes((input) =>
    Effect.gen(function* () {
      const { service, caller, projectId } = yield* context(input.projectId);
      if (caller === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Thread preferences require a calling thread.",
        });
      return yield* service
        .preferences({ ...input, projectId, threadId: caller.id })
        .pipe(Effect.mapError(failure));
    }),
  ),
});
