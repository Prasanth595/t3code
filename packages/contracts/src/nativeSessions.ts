import * as Schema from "effect/Schema";
import {
  MessageId,
  TurnItemId,
  CommandId,
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const Id = Schema.String.check(Schema.isUUID());
export const NativeSessionProcess = Schema.Struct({
  pid: PositiveInt,
  start: TrimmedNonEmptyString,
  boot: TrimmedNonEmptyString,
});
export interface NativeSessionProcess extends Schema.Schema.Type<typeof NativeSessionProcess> {}
export const NativeSessionDaemonProof = Schema.Struct({
  process: NativeSessionProcess,
  executable: TrimmedNonEmptyString,
  codexIdentity: TrimmedNonEmptyString,
  socket: TrimmedNonEmptyString,
  socketIdentity: TrimmedNonEmptyString,
  controlIdentity: TrimmedNonEmptyString,
  rendezvous: TrimmedNonEmptyString,
  rendezvousIdentity: TrimmedNonEmptyString,
  uid: NonNegativeInt,
});
export interface NativeSessionDaemonProof extends Schema.Schema.Type<
  typeof NativeSessionDaemonProof
> {}
export const NativeSessionBinding = Schema.Struct({
  home: TrimmedNonEmptyString,
  nativeId: Id,
  cwd: TrimmedNonEmptyString,
  nativeStores: Schema.Struct({
    sessionStore: TrimmedNonEmptyString,
    sessionStoreIdentity: TrimmedNonEmptyString,
    writerLockStore: TrimmedNonEmptyString,
    writerLockStoreIdentity: TrimmedNonEmptyString,
  }),
  protocolVersion: Schema.Literals(["0.163.0", "0.164.0"]),
  transport: Schema.Struct({
    kind: Schema.Literal("shared-daemon"),
    proof: NativeSessionDaemonProof,
  }),
});
export interface NativeSessionBinding extends Schema.Schema.Type<typeof NativeSessionBinding> {}
export const NativeSessionSettings = Schema.Struct({
  model: TrimmedNonEmptyString,
  reasoningEffort: Schema.Literals([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]),
  approvalPolicy: Schema.Literals(["untrusted", "on-failure", "on-request", "never"]),
  sandboxPolicy: Schema.Union([
    Schema.Struct({ type: Schema.Literal("dangerFullAccess") }),
    Schema.Struct({
      type: Schema.Literal("readOnly"),
      networkAccess: Schema.optionalKey(Schema.Boolean),
    }),
    Schema.Struct({
      type: Schema.Literal("workspaceWrite"),
      writableRoots: Schema.optionalKey(Schema.Array(Schema.String)),
      networkAccess: Schema.optionalKey(Schema.Boolean),
      excludeSlashTmp: Schema.optionalKey(Schema.Boolean),
      excludeTmpdirEnvVar: Schema.optionalKey(Schema.Boolean),
    }),
  ]),
});
export interface NativeSessionSettings extends Schema.Schema.Type<typeof NativeSessionSettings> {}
export const NativeSessionController = Schema.Union([
  Schema.Struct({ type: Schema.Literal("external"), epoch: NonNegativeInt }),
  Schema.Struct({ type: Schema.Literal("adopting"), epoch: NonNegativeInt }),
  Schema.Struct({ type: Schema.Literal("t3"), epoch: NonNegativeInt }),
  Schema.Struct({ type: Schema.Literal("releasing"), epoch: NonNegativeInt }),
]);
export type NativeSessionController = typeof NativeSessionController.Type;
export const NativeSessionBlocker = Schema.Struct({
  code: TrimmedNonEmptyString,
  ids: Schema.Array(Schema.String),
  nextAction: Schema.Literals([
    "retry-same-operation",
    "wait-for-exit",
    "stop-selected-work",
    "inspect-unknown-delivery",
    "reselect-source",
    "unsupported",
  ]),
});
export interface NativeSessionBlocker extends Schema.Schema.Type<typeof NativeSessionBlocker> {}
const Destination = Schema.Struct({
  workspaceId: TrimmedNonEmptyString,
  terminalId: TrimmedNonEmptyString,
  process: NativeSessionProcess,
});
export const NativeSessionReleaseReceipt = Schema.Struct({
  operationId: Id,
  epoch: NonNegativeInt,
  nativeId: Id,
  launchActionId: Id,
  destination: Destination,
});
export interface NativeSessionReleaseReceipt extends Schema.Schema.Type<
  typeof NativeSessionReleaseReceipt
> {}
const ScopeFields = {
  contractVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
};
const OperationFields = { ...ScopeFields, operationId: Id, commandId: CommandId };
export const NativeSessionAdoptInput = Schema.Struct({
  ...OperationFields,
  binding: NativeSessionBinding,
  settings: NativeSessionSettings,
  providerInstanceId: ProviderInstanceId,
  expectedEpoch: NonNegativeInt,
  sourceStopped: Schema.Struct({
    evidenceId: TrimmedNonEmptyString,
    process: NativeSessionProcess,
  }),
  previousLaunch: Schema.optionalKey(
    Schema.Struct({ operationId: Id, actionId: Id, process: NativeSessionProcess }),
  ),
});
export interface NativeSessionAdoptInput extends Schema.Schema.Type<
  typeof NativeSessionAdoptInput
> {}
export const NativeSessionReleaseInput = Schema.Struct({
  ...OperationFields,
  expectedEpoch: NonNegativeInt,
  destination: Destination,
  launchActionId: Id,
});
export interface NativeSessionReleaseInput extends Schema.Schema.Type<
  typeof NativeSessionReleaseInput
> {}
export const NativeSessionRefreshInput = Schema.Struct(OperationFields);
export interface NativeSessionRefreshInput extends Schema.Schema.Type<
  typeof NativeSessionRefreshInput
> {}
export const NativeSessionStatusInput = Schema.Struct({
  ...ScopeFields,
  operationId: Schema.optionalKey(Id),
});
export interface NativeSessionStatusInput extends Schema.Schema.Type<
  typeof NativeSessionStatusInput
> {}
const History = Schema.Struct({
  createdWithCliVersion: Schema.optionalKey(Schema.String),
  authority: Schema.Literal("native"),
  generation: NonNegativeInt,
  complete: Schema.Boolean,
});
export const NativeSessionResult = Schema.Struct({
  ...ScopeFields,
  state: Schema.Literals(["ready", "pending", "blocked"]),
  operationId: Schema.NullOr(Id),
  commandId: Schema.NullOr(CommandId),
  nativeId: Schema.NullOr(Id),
  controller: Schema.NullOr(NativeSessionController),
  settings: Schema.NullOr(NativeSessionSettings),
  history: Schema.NullOr(History),
  lastAcknowledgedEffectId: Schema.NullOr(Schema.String),
  unresolvedEffectIds: Schema.Array(Schema.String),
  blockers: Schema.Array(NativeSessionBlocker),
  writer: Schema.Literals(["verified-daemon", "unknown"]),
  releaseReceipt: Schema.NullOr(NativeSessionReleaseReceipt),
});
export interface NativeSessionResult extends Schema.Schema.Type<typeof NativeSessionResult> {}
export class NativeSessionMcpFailure extends Schema.TaggedError<NativeSessionMcpFailure>()(
  "NativeSessionMcpFailure",
  {
    code: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,79}$/)),
    threadId: ThreadId,
    nextAction: NativeSessionBlocker.fields.nextAction,
  },
) {}
export function nativeSessionBlocker(
  code: string,
  ids: ReadonlyArray<string> = [],
): NativeSessionBlocker {
  const nextAction =
    code === "source-still-running"
      ? "wait-for-exit"
      : code === "unknown-delivery" || code === "launch-reservation-unresolved"
        ? "inspect-unknown-delivery"
        : code.includes("active") || code.includes("pending-request") || code === "queued-work"
          ? "stop-selected-work"
          : code === "history-changing" || code === "native-connection-unsettled"
            ? "retry-same-operation"
            : code === "destination-environment-mismatch" ||
                code === "destination-project-mismatch" ||
                code === "native-reference-mismatch"
              ? "reselect-source"
              : "unsupported";
  return { code, ids, nextAction };
}
export class NativeSessionError extends Schema.TaggedError<NativeSessionError>()(
  "NativeSessionError",
  { code: TrimmedNonEmptyString, threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return `Native session operation failed (${this.code}).`;
  }
}
export const NativeSessionRecord = Schema.Struct({
  connectionId: Schema.optionalKey(Schema.String),
  mcpServerName: Schema.optionalKey(Schema.String),
  key: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  binding: NativeSessionBinding,
  settings: NativeSessionSettings,
  controller: NativeSessionController,
  history: History,
  operationId: Id,
  releaseReceipt: Schema.NullOr(NativeSessionReleaseReceipt),
  blockers: Schema.Array(NativeSessionBlocker),
});
export interface NativeSessionRecord extends Schema.Schema.Type<typeof NativeSessionRecord> {}
export const NativeSessionOperation = Schema.Struct({
  operationId: Id,
  commandId: CommandId,
  threadId: ThreadId,
  kind: Schema.Literals(["adopt", "release", "refresh"]),
  payloadHash: Schema.String,
  result: Schema.NullOr(NativeSessionResult),
});
export interface NativeSessionOperation extends Schema.Schema.Type<typeof NativeSessionOperation> {}
export const NativeSessionEffect = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  operationId: Schema.String,
  epoch: NonNegativeInt,
  connectionId: TrimmedNonEmptyString,
  method: TrimmedNonEmptyString,
  paramsHash: Schema.String,
  state: Schema.Literals(["uncertain", "acknowledged", "settled", "awaiting-response"]),
  nativeRequestId: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  nativeTurnId: Schema.optionalKey(Schema.String),
  lifecycleResult: Schema.optionalKey(Schema.Literals(["unsubscribed", "resumed"])),
});
export interface NativeSessionEffect extends Schema.Schema.Type<typeof NativeSessionEffect> {}
export const NativeSessionHistoryItem = Schema.Struct({
  ordinal: NonNegativeInt,
  nativeTurnId: Schema.String,
  nativeItemId: Schema.String,
  messageId: Schema.NullOr(MessageId),
  turnItemId: TurnItemId,
  payloadHash: Schema.String,
});
export interface NativeSessionHistoryItem extends Schema.Schema.Type<
  typeof NativeSessionHistoryItem
> {}
export const NativeSessionHistoryIndex = Schema.Struct({
  threadId: ThreadId,
  generation: NonNegativeInt,
  items: Schema.Array(NativeSessionHistoryItem),
  removedMessageIds: Schema.optionalKey(Schema.Array(MessageId)),
  removedTurnItemIds: Schema.optionalKey(Schema.Array(TurnItemId)),
});
export interface NativeSessionHistoryIndex extends Schema.Schema.Type<
  typeof NativeSessionHistoryIndex
> {}
export const NativeSessionJournalEntry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("history"), value: NativeSessionHistoryIndex }),
  Schema.Struct({ type: Schema.Literal("session"), value: NativeSessionRecord }),
  Schema.Struct({ type: Schema.Literal("operation"), value: NativeSessionOperation }),
  Schema.Struct({ type: Schema.Literal("effect"), value: NativeSessionEffect }),
]);
export type NativeSessionJournalEntry = typeof NativeSessionJournalEntry.Type;
export const NATIVE_SESSION_METHODS = {
  adopt: "nativeSessions.adopt",
  release: "nativeSessions.release",
  refresh: "nativeSessions.refresh",
  status: "nativeSessions.status",
} as const;
export const NativeSessionObservation = Schema.Struct({
  createdWithCliVersion: Schema.optionalKey(Schema.String),
  complete: Schema.Boolean,
  digest: Schema.String,
  turns: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      items: Schema.Array(
        Schema.Struct({ id: Schema.String, type: Schema.String, payload: Schema.Unknown }),
      ),
    }),
  ),
  blockers: Schema.Array(NativeSessionBlocker),
});
export interface NativeSessionObservation extends Schema.Schema.Type<
  typeof NativeSessionObservation
> {}
