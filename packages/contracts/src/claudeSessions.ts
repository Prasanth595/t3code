import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as SchemaParser from "effect/SchemaParser";
import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const UUID = Schema.String.check(Schema.isUUID(), Schema.isPattern(/^[0-9a-f-]+$/));
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Decimal = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/));
const Positive = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const AbsolutePath = Schema.String.check(Schema.isPattern(/^\//), Schema.isMaxLength(4096));
const strictStruct = <const Fields extends Schema.Struct.Fields>(fields: Fields) => {
  const schema = Schema.Struct(fields);
  const codec = Schema.declareConstructor<typeof schema.Type, typeof schema.Encoded>()(
    [schema],
    ([resolved]) =>
      (input, _ast, options) =>
        SchemaParser.decodeUnknownEffect(resolved)(input, {
          ...options,
          onExcessProperty: "error",
        }),
    {
      toCodecJson: () =>
        Schema.link<typeof schema.Type>()(schema, SchemaTransformation.passthrough()),
    },
  );
  return Object.assign(codec, { fields });
};

export const ClaudeSessionProcess = strictStruct({ pid: Positive, start: Decimal, boot: UUID });
export interface ClaudeSessionProcess extends Schema.Schema.Type<typeof ClaudeSessionProcess> {}
const PhysicalIdentity = strictStruct({ device: Decimal, inode: Decimal });
export const ClaudeSessionFileIdentity = strictStruct({
  ...PhysicalIdentity.fields,
  path: AbsolutePath,
});
export interface ClaudeSessionFileIdentity extends Schema.Schema.Type<
  typeof ClaudeSessionFileIdentity
> {}
export const ClaudeSessionTerminal = strictStruct({
  boot: UUID,
  socket: PhysicalIdentity,
  workspaceId: TrimmedNonEmptyString,
  tabId: TrimmedNonEmptyString,
  paneId: TrimmedNonEmptyString,
  terminalId: TrimmedNonEmptyString,
  pty: PhysicalIdentity,
  shell: ClaudeSessionProcess,
});
export interface ClaudeSessionTerminal extends Schema.Schema.Type<typeof ClaudeSessionTerminal> {}
export const ClaudeSessionSelection = strictStruct({
  profile: Schema.Literal("manual-selected-v1"),
  model: TrimmedNonEmptyString,
  runtimeMode: Schema.Literals(["approval-required", "full-access"]),
  effort: Schema.optionalKey(Schema.Literals(["low", "medium", "high", "xhigh", "max"])),
});
export interface ClaudeSessionSelection extends Schema.Schema.Type<typeof ClaudeSessionSelection> {}
export const ClaudeSessionScope = strictStruct({
  contractVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId.check(Schema.isUUID(), Schema.isPattern(/^[0-9a-f-]+$/)),
});
export interface ClaudeSessionScope extends Schema.Schema.Type<typeof ClaudeSessionScope> {}
const PreviousReturn = strictStruct({
  reservationId: UUID,
  actionId: UUID,
  kind: Schema.Literal("launch-observed-exited"),
  process: ClaudeSessionProcess,
  planDigest: Digest,
  terminalDigest: Digest,
});
export const ClaudeSessionAdoptInput = strictStruct({
  ...ClaudeSessionScope.fields,
  operationId: UUID,
  expectedEpoch: Schema.NullOr(Positive),
  providerInstanceId: ProviderInstanceId,
  nativeId: UUID,
  selection: ClaudeSessionSelection,
  sourceStopped: strictStruct({
    kind: Schema.Literal("operator-stopped"),
    terminal: ClaudeSessionTerminal,
    knownPreviousProcess: Schema.NullOr(ClaudeSessionProcess),
  }),
  previousReturn: Schema.optionalKey(PreviousReturn),
});
export interface ClaudeSessionAdoptInput extends Schema.Schema.Type<
  typeof ClaudeSessionAdoptInput
> {}
export const ClaudeSessionRefreshInput = strictStruct({
  ...ClaudeSessionScope.fields,
  operationId: UUID,
  expectedEpoch: Positive,
});
export interface ClaudeSessionRefreshInput extends Schema.Schema.Type<
  typeof ClaudeSessionRefreshInput
> {}
export const ClaudeSessionReleaseInput = strictStruct({
  ...ClaudeSessionScope.fields,
  operationId: UUID,
  expectedEpoch: Positive,
  planDigest: Digest,
  destination: ClaudeSessionTerminal,
});
export interface ClaudeSessionReleaseInput extends Schema.Schema.Type<
  typeof ClaudeSessionReleaseInput
> {}
export const ClaudeSessionStatusInput = strictStruct({
  ...ClaudeSessionScope.fields,
  operationId: Schema.optionalKey(UUID),
});
export interface ClaudeSessionStatusInput extends Schema.Schema.Type<
  typeof ClaudeSessionStatusInput
> {}
export const ClaudeSessionIdentityPlan = strictStruct({
  planVersion: Schema.Literal(1),
  planDigest: Digest,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ClaudeSessionScope.fields.threadId,
  providerInstanceId: ProviderInstanceId,
  nativeId: UUID,
  home: ClaudeSessionFileIdentity,
  configDir: Schema.Union([
    strictStruct({ kind: Schema.Literal("unset"), effectiveRoot: ClaudeSessionFileIdentity }),
    strictStruct({
      kind: Schema.Literal("set"),
      value: AbsolutePath,
      effectiveRoot: ClaudeSessionFileIdentity,
    }),
  ]),
  projectsRoot: ClaudeSessionFileIdentity,
  transcript: ClaudeSessionFileIdentity,
  cwd: ClaudeSessionFileIdentity,
  executable: strictStruct({ file: ClaudeSessionFileIdentity, sha256: Digest }),
  selection: ClaudeSessionSelection,
  sdkPermissionMode: Schema.Literals(["default", "bypassPermissions"]),
  configurationDigest: Digest,
  herdrLaunch: strictStruct({
    executable: AbsolutePath,
    args: Schema.Array(Schema.String),
    cwd: AbsolutePath,
    environment: strictStruct({
      HOME: AbsolutePath,
      CLAUDE_CONFIG_DIR: Schema.NullOr(AbsolutePath),
    }),
  }),
});
export interface ClaudeSessionIdentityPlan extends Schema.Schema.Type<
  typeof ClaudeSessionIdentityPlan
> {}
export const ClaudeSessionRuntime = Schema.Union([
  strictStruct({
    kind: Schema.Literal("not-started"),
    nativeIdentity: Schema.Literal("not-observed"),
  }),
  strictStruct({
    kind: Schema.Literal("owned-query"),
    generation: UUID,
    process: ClaudeSessionProcess,
    nativeIdentity: Schema.Literals(["not-observed", "observed-exact-uuid"]),
  }),
  strictStruct({ kind: Schema.Literal("exit-pending"), generation: UUID }),
  strictStruct({ kind: Schema.Literal("exited"), exitReceiptId: UUID }),
  strictStruct({ kind: Schema.Literal("unknown") }),
]);
export const ClaudeSessionView = strictStruct({
  plan: ClaudeSessionIdentityPlan,
  controller: strictStruct({
    type: Schema.Literals(["adopting", "t3", "releasing", "external"]),
    epoch: Positive,
  }),
  history: strictStruct({
    authority: Schema.Literal("native"),
    scope: Schema.Literal("root-active-chain"),
    generation: Positive,
    digest: Digest,
  }),
  runtime: ClaudeSessionRuntime,
  settingsBasis: Schema.Literal("selected-destination"),
  writerScope: Schema.Literal("participating-clients"),
  unmanagedWriterExclusion: Schema.Literal("not-proved"),
});
export interface ClaudeSessionView extends Schema.Schema.Type<typeof ClaudeSessionView> {}
export const ClaudeSessionReservation = strictStruct({
  reservationId: UUID,
  operationId: UUID,
  actionId: UUID,
  epoch: Positive,
  planDigest: Digest,
  finalHistoryDigest: Digest,
  destination: ClaudeSessionTerminal,
  processDisposition: Schema.Union([
    strictStruct({ kind: Schema.Literal("never-started") }),
    strictStruct({ kind: Schema.Literal("exited"), exitReceiptId: UUID }),
  ]),
});
export interface ClaudeSessionReservation extends Schema.Schema.Type<
  typeof ClaudeSessionReservation
> {}
export const ClaudeSessionBlocker = strictStruct({
  code: Schema.Literals([
    "contract-unsupported",
    "scope-mismatch",
    "provider-unavailable",
    "unsupported-platform",
    "unsupported-profile",
    "identity-unavailable",
    "identity-changed",
    "settings-changed",
    "history-unavailable",
    "history-incomplete",
    "history-changed",
    "native-binding-owned",
    "target-not-empty",
    "source-not-idle",
    "terminal-changed",
    "previous-return-unresolved",
    "stale-epoch",
    "operation-conflict",
    "managed-work-active",
    "managed-delivery-unknown",
    "process-exit-unproved",
    "runtime-state-unknown",
    "projection-conflict",
  ]),
  detail: Schema.String.check(Schema.isMaxLength(1000)),
  nextAction: Schema.Literals([
    "retry-same-operation",
    "wait",
    "resolve-in-t3",
    "reselect",
    "unsupported",
  ]),
});
export interface ClaudeSessionBlocker extends Schema.Schema.Type<typeof ClaudeSessionBlocker> {}
export const ClaudeSessionResult = strictStruct({
  ...ClaudeSessionScope.fields,
  provider: Schema.Literal("claude"),
  operationId: Schema.NullOr(UUID),
  state: Schema.Literals(["ready", "pending", "blocked", "not-found"]),
  view: Schema.NullOr(ClaudeSessionView),
  reservation: Schema.NullOr(ClaudeSessionReservation),
  blockers: Schema.Array(ClaudeSessionBlocker),
});
export interface ClaudeSessionResult extends Schema.Schema.Type<typeof ClaudeSessionResult> {}
export const CLAUDE_SESSION_METHODS = {
  adopt: "claudeSessions.adopt",
  refresh: "claudeSessions.refresh",
  release: "claudeSessions.release",
  status: "claudeSessions.status",
} as const;

export const ClaudeSessionAdoptRequest = strictStruct({ input: ClaudeSessionAdoptInput });
export const ClaudeSessionRefreshRequest = strictStruct({ input: ClaudeSessionRefreshInput });
export const ClaudeSessionReleaseRequest = strictStruct({ input: ClaudeSessionReleaseInput });
export const ClaudeSessionStatusRequest = strictStruct({ input: ClaudeSessionStatusInput });
