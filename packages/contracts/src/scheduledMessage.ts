import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const ScheduledMessageId = TrimmedNonEmptyString.pipe(Schema.brand("ScheduledMessageId"));
export type ScheduledMessageId = typeof ScheduledMessageId.Type;

export const ScheduledMessageStatus = Schema.Literals([
  "pending",
  "sending",
  "sent",
  "failed",
  "cancelled",
]);
export type ScheduledMessageStatus = typeof ScheduledMessageStatus.Type;

export const ScheduledMessage = Schema.Struct({
  id: ScheduledMessageId,
  prompt: Schema.String.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  sendAt: IsoDateTime,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  status: ScheduledMessageStatus,
  error: Schema.NullOr(Schema.String),
  sentThreadId: Schema.NullOr(ThreadId),
});
export type ScheduledMessage = typeof ScheduledMessage.Type;

export const ScheduledMessageListInput = Schema.Struct({});
export type ScheduledMessageListInput = typeof ScheduledMessageListInput.Type;

export const ScheduledMessageListResult = Schema.Struct({
  messages: Schema.Array(ScheduledMessage),
});
export type ScheduledMessageListResult = typeof ScheduledMessageListResult.Type;

export const ScheduledMessageCreateInput = Schema.Struct({
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  sendAt: IsoDateTime,
  projectId: ProjectId,
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: Schema.optional(OrchestrationV2Actor),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
});
export type ScheduledMessageCreateInput = typeof ScheduledMessageCreateInput.Type;

export const ScheduledMessageCreateResult = Schema.Struct({
  message: ScheduledMessage,
});
export type ScheduledMessageCreateResult = typeof ScheduledMessageCreateResult.Type;

export const ScheduledMessageCancelInput = Schema.Struct({
  id: ScheduledMessageId,
});
export type ScheduledMessageCancelInput = typeof ScheduledMessageCancelInput.Type;

export const ScheduledMessageCancelResult = Schema.Struct({
  cancelled: Schema.Boolean,
});
export type ScheduledMessageCancelResult = typeof ScheduledMessageCancelResult.Type;

export class ScheduledMessageError extends Schema.TaggedError<ScheduledMessageError>()(
  "ScheduledMessageError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
