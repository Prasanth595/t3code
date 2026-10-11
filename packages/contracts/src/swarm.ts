import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CommandId, NodeId, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";

export const SwarmId = TrimmedNonEmptyString.pipe(Schema.brand("SwarmId"));
export type SwarmId = typeof SwarmId.Type;

export const SWARM_MAX_MEMBERS = 8;
export const SWARM_MAX_BRIEF_BYTES = 256 * 1024;
export const SWARM_MAX_MESSAGE_BYTES = 16 * 1024;
export const SWARM_MAX_PENDING_MESSAGES = 16;

export const OrchestrationV2SwarmAdmission = Schema.Union([
  Schema.Struct({ state: Schema.Literal("admitted") }),
  Schema.Struct({ state: Schema.Literal("revoked"), revokedAt: Schema.DateTimeUtc }),
]);

export const OrchestrationV2SwarmMember = Schema.Struct({
  threadId: ThreadId,
  taskId: NodeId,
  title: Schema.String,
  admission: OrchestrationV2SwarmAdmission,
});
export type OrchestrationV2SwarmMember = typeof OrchestrationV2SwarmMember.Type;

export const OrchestrationV2SwarmLifecycle = Schema.Union([
  Schema.Struct({ state: Schema.Literal("open") }),
  Schema.Struct({ state: Schema.Literal("closed"), closedAt: Schema.DateTimeUtc }),
]);

export const OrchestrationV2Swarm = Schema.Struct({
  id: SwarmId,
  ownerThreadId: ThreadId,
  ownerRunId: RunId,
  creationCommandId: CommandId,
  title: Schema.String,
  members: Schema.Array(OrchestrationV2SwarmMember).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(SWARM_MAX_MEMBERS),
  ),
  lifecycle: OrchestrationV2SwarmLifecycle,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});
export type OrchestrationV2Swarm = typeof OrchestrationV2Swarm.Type;

const admissionJson = Schema.Union([
  OrchestrationV2SwarmAdmission.members[0],
  OrchestrationV2SwarmAdmission.members[1].mapFields((fields) => ({
    ...fields,
    revokedAt: Schema.DateTimeUtcFromString,
  })),
]);
export const OrchestrationV2SwarmJson = OrchestrationV2Swarm.mapFields((fields) => ({
  ...fields,
  members: Schema.Array(
    OrchestrationV2SwarmMember.mapFields((member) => ({ ...member, admission: admissionJson })),
  ),
  lifecycle: Schema.Union([
    OrchestrationV2SwarmLifecycle.members[0],
    OrchestrationV2SwarmLifecycle.members[1].mapFields((lifecycle) => ({
      ...lifecycle,
      closedAt: Schema.DateTimeUtcFromString,
    })),
  ]),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
}));
export type OrchestrationV2SwarmJson = typeof OrchestrationV2SwarmJson.Type;

export const OrchestrationV2SwarmPeerDelivery = Schema.Struct({
  swarmId: SwarmId,
  ownerThreadId: ThreadId,
  senderThreadId: ThreadId,
  commandId: CommandId,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type OrchestrationV2SwarmPeerDelivery = typeof OrchestrationV2SwarmPeerDelivery.Type;

export const OrchestrationV2SwarmRunAdmission = Schema.Struct({
  senderThreadId: ThreadId,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type OrchestrationV2SwarmRunAdmission = typeof OrchestrationV2SwarmRunAdmission.Type;

export const OrchestrationV2StopSwarmInput = Schema.Struct({
  threadId: ThreadId,
  swarmId: SwarmId,
  commandId: CommandId,
});
export type OrchestrationV2StopSwarmInput = typeof OrchestrationV2StopSwarmInput.Type;

export class OrchestrationV2StopSwarmError extends Schema.TaggedError<OrchestrationV2StopSwarmError>()(
  "OrchestrationV2StopSwarmError",
  {
    swarmId: SwarmId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not stop this swarm.";
  }
}

export const OrchestrationV2Swarms = Schema.optional(Schema.Array(OrchestrationV2Swarm)).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
);
export const OrchestrationV2SwarmsJson = Schema.optional(
  Schema.Array(OrchestrationV2SwarmJson),
).pipe(Schema.withDecodingDefault(Effect.succeed([])));

export function mergeOrchestrationV2Swarm(
  previous: OrchestrationV2Swarm | undefined,
  incoming: OrchestrationV2Swarm,
): OrchestrationV2Swarm {
  if (previous === undefined) return incoming;
  return {
    ...previous,
    lifecycle: previous.lifecycle.state === "closed" ? previous.lifecycle : incoming.lifecycle,
    members: previous.members.map((member) => ({
      ...member,
      admission:
        member.admission.state === "revoked"
          ? member.admission
          : (incoming.members.find(
              (row) => row.threadId === member.threadId && row.taskId === member.taskId,
            )?.admission ?? member.admission),
    })),
    updatedAt:
      DateTime.toEpochMillis(previous.updatedAt) > DateTime.toEpochMillis(incoming.updatedAt)
        ? previous.updatedAt
        : incoming.updatedAt,
  };
}
