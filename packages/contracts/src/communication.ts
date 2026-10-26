import * as Schema from "effect/Schema";

import {
  CommandId,
  MessageId,
  NodeId,
  NonNegativeInt,
  PositiveInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const CommunicationPort = Schema.Literals([
  "user.in",
  "user.out",
  "internal.in",
  "internal.out",
]);
export type CommunicationPort = typeof CommunicationPort.Type;

export const CommunicationRoute = Schema.Union([
  Schema.Struct({ port: Schema.Literal("user.in"), audience: Schema.Literal("coordinator") }),
  Schema.Struct({ port: Schema.Literal("user.out"), audience: Schema.Literal("human") }),
  Schema.Struct({ port: Schema.Literal("internal.in"), audience: Schema.Literal("coordinator") }),
  Schema.Struct({
    port: Schema.Literal("internal.out"),
    audience: Schema.Literals(["coordinator", "agent", "program"]),
  }),
]);
export type CommunicationRoute = typeof CommunicationRoute.Type;

export const CommunicationOutputRoute = Schema.Union([
  Schema.Struct({ port: Schema.Literal("user.out"), audience: Schema.Literal("human") }),
  Schema.Struct({
    port: Schema.Literal("internal.out"),
    audience: Schema.Literals(["coordinator", "agent", "program"]),
  }),
]);
export type CommunicationOutputRoute = typeof CommunicationOutputRoute.Type;

export const CommunicationProducer = Schema.Struct({
  kind: Schema.Literals(["human", "agent", "provider", "scheduler", "monitor", "server"]),
  id: TrimmedNonEmptyString,
  environmentId: Schema.optional(TrimmedNonEmptyString),
  sessionId: Schema.optional(TrimmedNonEmptyString),
  taskId: Schema.optional(TrimmedNonEmptyString),
});
export type CommunicationProducer = typeof CommunicationProducer.Type;

export const CommunicationDelivery = Schema.Struct({
  state: Schema.Literals([
    "accepted",
    "pending",
    "offered",
    "provider_accepted",
    "consumption_unknown",
    "consumed",
    "cancelled",
    "failed",
  ]),
  generation: Schema.optional(PositiveInt),
  attempt: Schema.optional(NonNegativeInt),
});
export type CommunicationDelivery = typeof CommunicationDelivery.Type;

// A verified envelope is created by the server from its authenticated caller context.
// Legacy records omit this field; their native role never grants human provenance.
export const CommunicationEnvelope = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  classification: Schema.Literal("verified"),
  id: MessageId,
  threadId: ThreadId,
  route: CommunicationRoute,
  producer: CommunicationProducer,
  authorizedBy: Schema.optional(TrimmedNonEmptyString),
  author: Schema.optional(CommunicationProducer),
  recipientId: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  correlationId: TrimmedNonEmptyString,
  causationId: Schema.optional(TrimmedNonEmptyString),
  replyTo: Schema.optional(MessageId),
  parentRunId: Schema.optional(RunId),
  taskId: Schema.optional(NodeId),
  idempotencyKey: Schema.optional(CommandId),
  content: Schema.optional(
    Schema.Struct({
      text: Schema.optional(Schema.String),
      artifactRefs: Schema.Array(TrimmedNonEmptyString),
    }),
  ),
  providerEvidence: Schema.optional(
    Schema.Struct({
      role: Schema.optional(Schema.String),
      channel: Schema.optional(Schema.String),
      sessionId: Schema.optional(Schema.String),
    }),
  ),
  delivery: CommunicationDelivery,
});
export type CommunicationEnvelope = typeof CommunicationEnvelope.Type;

export const CommunicationLegacyClassification = Schema.Literal("legacy_unknown");
export type CommunicationLegacyClassification = typeof CommunicationLegacyClassification.Type;
