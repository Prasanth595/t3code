import * as Schema from "effect/Schema";
import {
  CommandId,
  ProjectId,
  ThreadId,
  IsoDateTime,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  RuntimeMode,
  ProviderInteractionMode,
  runtimeModeRank,
  interactionModeRank,
} from "./providerPolicy.ts";
import { ChatAttachment } from "./chatAttachment.ts";

export const CoordinationKind = Schema.Literals(["update", "request", "blocker"]);
export type CoordinationKind = typeof CoordinationKind.Type;
export const CoordinationStatus = Schema.Literals(["open", "resolved", "declined", "expired"]);
export const CoordinationEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  revision: Schema.Number,
  projectId: ProjectId,
  topic: TrimmedNonEmptyString,
  kind: CoordinationKind,
  status: CoordinationStatus,
  createdBy: Schema.Literals(["user", "agent"]),
  senderThreadId: Schema.NullOr(ThreadId),
  senderModes: Schema.optional(
    Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
  ),
  targetThreadId: Schema.NullOr(ThreadId),
  replyToId: Schema.NullOr(TrimmedNonEmptyString),
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  updateCount: Schema.Number,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CoordinationEntry = typeof CoordinationEntry.Type;

/** Unknown historical agent provenance remains readable but is never injected automatically. */
export function canDeliverCoordinationAutomatically(
  entry: Pick<CoordinationEntry, "createdBy" | "senderModes">,
  recipient: { runtimeMode: RuntimeMode; interactionMode: ProviderInteractionMode },
) {
  return (
    entry.createdBy === "user" ||
    (entry.senderModes !== undefined &&
      runtimeModeRank(recipient.runtimeMode) <= runtimeModeRank(entry.senderModes.runtimeMode) &&
      interactionModeRank(recipient.interactionMode) <=
        interactionModeRank(entry.senderModes.interactionMode))
  );
}

/** Broadcast discussions are open to any thread; direct discussions keep their participants. */
export function canReplyToCoordination(
  entry: Pick<CoordinationEntry, "senderThreadId" | "targetThreadId">,
  threadId: ThreadId,
): boolean {
  return (
    entry.targetThreadId === null ||
    entry.senderThreadId === threadId ||
    entry.targetThreadId === threadId
  );
}

export const CoordinationPreferences = Schema.Struct({
  readRevision: Schema.Number,
  paused: Schema.Boolean,
  mutedTopics: Schema.Array(Schema.String),
});
export type CoordinationPreferences = typeof CoordinationPreferences.Type;
export const CoordinationThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  status: Schema.Literals(["working", "waiting_for_agent", "waiting_for_user", "done", "idle"]),
  updatedAt: IsoDateTime,
});
export const CoordinationSnapshot = Schema.Struct({
  revision: Schema.Number,
  entries: Schema.Array(CoordinationEntry),
  threads: Schema.Array(CoordinationThread),
  preferences: CoordinationPreferences,
  unreadCount: Schema.Number,
  nextBeforeRevision: Schema.NullOr(Schema.Number),
});
export type CoordinationSnapshot = typeof CoordinationSnapshot.Type;
export const CoordinationReadInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  beforeRevision: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type CoordinationReadInput = typeof CoordinationReadInput.Type;
export const CoordinationPostInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  senderThreadId: Schema.optional(ThreadId),
  targetThreadId: Schema.optional(ThreadId),
  topic: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  kind: CoordinationKind,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(16000)),
  replyToId: Schema.optional(TrimmedNonEmptyString),
  attachments: Schema.optional(Schema.Array(ChatAttachment).check(Schema.isMaxLength(8))),
});
export type CoordinationPostInput = typeof CoordinationPostInput.Type;
export const CoordinationResolveInput = Schema.Struct({
  projectId: ProjectId,
  entryId: TrimmedNonEmptyString,
  status: Schema.Literals(["resolved", "declined"]),
  actorThreadId: Schema.optional(ThreadId),
});
export type CoordinationResolveInput = typeof CoordinationResolveInput.Type;
export const CoordinationPreferencesInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  readRevision: Schema.optional(Schema.Number),
  paused: Schema.optional(Schema.Boolean),
  mutedTopics: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(100))),
});
export type CoordinationPreferencesInput = typeof CoordinationPreferencesInput.Type;
export class CoordinationError extends Schema.TaggedError<CoordinationError>()(
  "CoordinationError",
  {
    reason: Schema.Literals(["not_found", "forbidden", "conflict", "limit", "storage"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const CoordinationHandleInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  entryId: Schema.optional(TrimmedNonEmptyString),
  entryRevision: Schema.optional(Schema.Number),
  action: Schema.Literals(["handle_now", "handle_after", "return_to_task"]),
});
export type CoordinationHandleInput = typeof CoordinationHandleInput.Type;
