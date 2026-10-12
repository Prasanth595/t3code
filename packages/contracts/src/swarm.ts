import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CommandId,
  NodeId,
  RunId,
  RunAttemptId,
  ProviderThreadId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ModelSelection } from "./modelSelection.ts";
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
});
export type OrchestrationV2SwarmPeerDelivery = typeof OrchestrationV2SwarmPeerDelivery.Type;

export const OrchestrationV2ExecutionModes = Schema.Struct({
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type OrchestrationV2ExecutionModes = typeof OrchestrationV2ExecutionModes.Type;
export const OrchestrationV2SubmittedPolicy = Schema.Struct({
  ...OrchestrationV2ExecutionModes.fields,
  cwd: Schema.NullOr(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type OrchestrationV2SubmittedPolicy = typeof OrchestrationV2SubmittedPolicy.Type;

export const OrchestrationV2ExecutionScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ordinary") }),
  Schema.Struct({
    kind: Schema.Literal("swarm"),
    swarmId: SwarmId,
    creationCommandId: CommandId,
    ownerThreadId: ThreadId,
    memberThreadId: ThreadId,
    submissionCeiling: OrchestrationV2ExecutionModes,
    revocationDependencies: Schema.Array(ThreadId).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(SWARM_MAX_MEMBERS),
    ),
    configurationGuards: Schema.Array(
      Schema.Struct({ threadId: ThreadId, ceiling: OrchestrationV2ExecutionModes }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(SWARM_MAX_MEMBERS + 1)),
  }),
  Schema.Struct({ kind: Schema.Literal("denied"), swarmId: Schema.NullOr(SwarmId) }),
]);
export type OrchestrationV2ExecutionScope = typeof OrchestrationV2ExecutionScope.Type;

export const OrchestrationV2RunCauseSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("run"),
    threadId: ThreadId,
    runId: RunId,
    attemptId: Schema.NullOr(RunAttemptId),
  }),
  Schema.Struct({
    kind: Schema.Literal("native"),
    threadId: ThreadId,
    runId: RunId,
    attemptId: RunAttemptId,
    providerInstanceId: ProviderInstanceId,
    providerThreadId: ProviderThreadId,
    nativeThreadId: Schema.String,
    incarnation: TrimmedNonEmptyString,
  }),
]);
export type OrchestrationV2RunCauseSource = typeof OrchestrationV2RunCauseSource.Type;
export type OrchestrationV2NativeRunCauseSource = Extract<
  OrchestrationV2RunCauseSource,
  { kind: "native" }
>;

export const OrchestrationV2ExecutionCause = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("independent") }),
  Schema.Struct({
    kind: Schema.Literal("causal"),
    reason: Schema.Literals([
      "manual",
      "restart",
      "usage_limit",
      "delegated_completion",
      "native",
      "answer",
      "worktree",
      "delegation",
      "peer",
    ]),
    sources: Schema.Array(OrchestrationV2RunCauseSource).check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    kind: Schema.Literal("native_unowned"),
    process: OrchestrationV2RunCauseSource.members[1],
  }),
]);
export type OrchestrationV2ExecutionCause = typeof OrchestrationV2ExecutionCause.Type;

export const OrchestrationV2ExecutionDelivery = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("message_text") }),
  Schema.Struct({
    kind: Schema.Literal("adapter_buffered"),
    bufferId: TrimmedNonEmptyString,
    process: OrchestrationV2RunCauseSource.members[1],
    modelSelection: ModelSelection,
    bounds: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("frames"), nativeTurnId: Schema.NullOr(Schema.String) }),
      Schema.Struct({
        kind: Schema.Literal("inbox"),
        messageId: Schema.String,
        first: Schema.NullOr(Schema.String),
        after: Schema.NullOr(Schema.String),
      }),
    ]),
  }),
]);
export type OrchestrationV2ExecutionDelivery = typeof OrchestrationV2ExecutionDelivery.Type;

export const OrchestrationV2NativeCause = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("complete"),
    sources: Schema.Array(OrchestrationV2RunCauseSource.members[1]).check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    kind: Schema.Literal("incomplete"),
    knownSources: Schema.Array(OrchestrationV2RunCauseSource.members[1]),
    ordinaryProcess: Schema.NullOr(OrchestrationV2RunCauseSource.members[1]),
  }),
]);
export type OrchestrationV2NativeCause = typeof OrchestrationV2NativeCause.Type;

export const OrchestrationV2NativeAcceptance = Schema.Struct({
  incarnation: TrimmedNonEmptyString,
  onlyOrdinary: Schema.Boolean,
  policyAttemptId: RunAttemptId,
  acceptedAttemptId: RunAttemptId,
});
export type OrchestrationV2NativeAcceptance = typeof OrchestrationV2NativeAcceptance.Type;

export const OrchestrationV2StopSwarmInput = Schema.Struct({
  threadId: ThreadId,
  swarmId: SwarmId,
  memberThreadId: Schema.optional(ThreadId),
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
