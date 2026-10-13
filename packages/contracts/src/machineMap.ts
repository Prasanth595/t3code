/**
 * Fork: machine map. Shared types of the portal (`apps/machine-map`), the T3 server and the
 * desktop app. Requirement numbers (MM-xxx) refer to `apps/machine-map/SPEC.md`.
 */
import * as Schema from "effect/Schema";

import {
  AuthAdministrativeScopes,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  type AuthGrantScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  AuthTerminalReadScope,
} from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Wire version of the machine and page protocols. Bump on a breaking change. */
export const MACHINE_MAP_PROTOCOL = 1 as const;

/** An ISO 8601 time, for example `2026-10-13T08:00:00.000Z`. */
export const MapTime = TrimmedNonEmptyString;
export type MapTime = typeof MapTime.Type;

export const MachineId = TrimmedNonEmptyString.pipe(Schema.brand("MachineId"));
export type MachineId = typeof MachineId.Type;

export const MachineKind = Schema.Literals(["laptop", "desktop", "server"]);
export type MachineKind = typeof MachineKind.Type;

/** What one machine can do on another (MM-302). */
export const MachineLevel = Schema.Literals(["none", "read", "standard", "admin"]);
export type MachineLevel = typeof MachineLevel.Type;

/** What agents on a machine can do on the map itself (MM-802). */
export const MachineMapRole = Schema.Literals(["none", "read", "propose", "edit"]);
export type MachineMapRole = typeof MachineMapRole.Type;

export const MACHINE_LEVEL_SCOPES: Readonly<Record<MachineLevel, ReadonlyArray<AuthGrantScope>>> = {
  none: [],
  read: [
    AuthOrchestrationReadScope,
    AuthFilesystemReadScope,
    AuthTerminalReadScope,
    AuthDiagnosticsReadScope,
  ],
  standard: AuthStandardClientScopes,
  admin: AuthAdministrativeScopes,
};

/** The session subject of a machine on the server of another machine (MM-1305). */
export const machineSessionSubject = (machineId: MachineId): string => `machine:${machineId}`;

/** A place on the map, as fractions of the map area. */
export const MapPosition = Schema.Struct({
  x: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  y: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
export type MapPosition = typeof MapPosition.Type;

export const MachineRecord = Schema.Struct({
  id: MachineId,
  name: TrimmedNonEmptyString,
  kind: MachineKind,
  /** Client id of the machine token: the `common_name` of its Cloudflare Access JWT. */
  tokenClientId: TrimmedNonEmptyString,
  /** Tunnel hostname that the machine reports (MM-209). Null until its first report. */
  hostname: Schema.NullOr(TrimmedNonEmptyString),
  position: MapPosition,
  mapRole: MachineMapRole,
  createdAt: MapTime,
});
export type MachineRecord = typeof MachineRecord.Type;

export const ArrowRecord = Schema.Struct({
  from: MachineId,
  to: MachineId,
  level: MachineLevel,
  /** Agents on `from` can call T3 tools on `to` (MM-303). */
  agentTools: Schema.Boolean,
  /** MM-304: at this time the arrow returns to `revertLevel`. */
  expiresAt: Schema.NullOr(MapTime),
  revertLevel: Schema.NullOr(MachineLevel),
});
export type ArrowRecord = typeof ArrowRecord.Type;

export const SettingScope = Schema.Literals(["server", "client"]);
export type SettingScope = typeof SettingScope.Type;

/** Setting values by key. The T3 settings schemas validate them where they apply. */
export const SettingValues = Schema.Record(Schema.String, Schema.Unknown);
export type SettingValues = typeof SettingValues.Type;

export const ScopedSettingValues = Schema.Struct({
  server: SettingValues,
  client: SettingValues,
});
export type ScopedSettingValues = typeof ScopedSettingValues.Type;

export const ManagedSetting = Schema.Struct({ scope: SettingScope, key: TrimmedNonEmptyString });
export type ManagedSetting = typeof ManagedSetting.Type;

export const MapSettings = Schema.Struct({
  /** MM-406: only these settings are part of the map. */
  managed: Schema.Array(ManagedSetting),
  shared: ScopedSettingValues,
  overrides: Schema.Record(Schema.String, ScopedSettingValues),
});
export type MapSettings = typeof MapSettings.Type;

export const MapPreset = Schema.Struct({
  name: TrimmedNonEmptyString,
  arrows: Schema.Array(ArrowRecord),
  createdAt: MapTime,
});
export type MapPreset = typeof MapPreset.Type;

export const MachineMapDocument = Schema.Struct({
  revision: NonNegativeInt,
  machines: Schema.Array(MachineRecord),
  arrows: Schema.Array(ArrowRecord),
  settings: MapSettings,
  presets: Schema.Array(MapPreset),
});
export type MachineMapDocument = typeof MachineMapDocument.Type;

/** Who made a change or sent a command (MM-702). */
export const MapActor = Schema.Union([
  Schema.TaggedStruct("owner", { email: TrimmedNonEmptyString, device: Schema.String }),
  Schema.TaggedStruct("agent", {
    machineId: MachineId,
    threadId: Schema.NullOr(Schema.String),
    threadTitle: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("portal", { reason: TrimmedNonEmptyString }),
]);
export type MapActor = typeof MapActor.Type;

/**
 * One change of the map. A revision, a proposal and an undo are lists of changes. The portal
 * computes the inverse of each change when it applies it, so any revision can be undone.
 */
export const MapChange = Schema.Union([
  Schema.TaggedStruct("setArrow", { arrow: ArrowRecord }),
  Schema.TaggedStruct("setSetting", {
    /** Null sets the shared value. */
    machineId: Schema.NullOr(MachineId),
    scope: SettingScope,
    key: TrimmedNonEmptyString,
    /** False clears the value: a machine follows the shared value again. */
    present: Schema.Boolean,
    value: Schema.Unknown,
  }),
  Schema.TaggedStruct("manageSetting", {
    scope: SettingScope,
    key: TrimmedNonEmptyString,
    managed: Schema.Boolean,
  }),
  Schema.TaggedStruct("putMachine", { machine: MachineRecord }),
  Schema.TaggedStruct("removeMachine", { machineId: MachineId }),
  Schema.TaggedStruct("putPreset", { preset: MapPreset }),
  Schema.TaggedStruct("removePreset", { name: TrimmedNonEmptyString }),
]);
export type MapChange = typeof MapChange.Type;

export const MapRevision = Schema.Struct({
  revision: NonNegativeInt,
  at: MapTime,
  actor: MapActor,
  summary: TrimmedNonEmptyString,
  changes: Schema.Array(MapChange),
  /** The changes that undo this revision (MM-703). */
  inverse: Schema.Array(MapChange),
});
export type MapRevision = typeof MapRevision.Type;

/** A change from an agent that waits for the owner (MM-804). */
export const MapProposal = Schema.Struct({
  id: TrimmedNonEmptyString,
  at: MapTime,
  expiresAt: MapTime,
  actor: MapActor,
  summary: TrimmedNonEmptyString,
  changes: Schema.Array(MapChange),
  /** Why it waits: the map role is `propose`, or the change raises access for its own machine. */
  reason: Schema.Literals(["map-role", "self-escalation"]),
});
export type MapProposal = typeof MapProposal.Type;

/** MM-501. `rotateToken` is not here: the portal sends it as its own message. */
export const MachineCommandInput = Schema.Union([
  Schema.TaggedStruct("restartServer", {}),
  Schema.TaggedStruct("installUpdate", { whenIdle: Schema.Boolean }),
  Schema.TaggedStruct("stopAllAgents", {}),
  Schema.TaggedStruct("pauseScheduledTasks", {}),
  Schema.TaggedStruct("resumeScheduledTasks", {}),
  Schema.TaggedStruct("reloadWindows", {}),
  Schema.TaggedStruct("startThread", {
    projectId: TrimmedNonEmptyString,
    title: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("revokeClient", { sessionId: TrimmedNonEmptyString }),
  Schema.TaggedStruct("collectDiagnostics", {}),
  Schema.TaggedStruct("testArrow", { to: MachineId }),
]);
export type MachineCommandInput = typeof MachineCommandInput.Type;
export type MachineCommandKind = MachineCommandInput["_tag"];

export const MachineCommandKindSchema = Schema.Literals([
  "restartServer",
  "installUpdate",
  "stopAllAgents",
  "pauseScheduledTasks",
  "resumeScheduledTasks",
  "reloadWindows",
  "startThread",
  "revokeClient",
  "collectDiagnostics",
  "testArrow",
]);

/** MM-605. */
export const CommandDelivery = Schema.Literals(["online", "idle"]);
export type CommandDelivery = typeof CommandDelivery.Type;

export const CommandStatus = Schema.Literals([
  "queued",
  "delivered",
  "succeeded",
  "failed",
  "expired",
  "cancelled",
]);
export type CommandStatus = typeof CommandStatus.Type;

export const MachineCommand = Schema.Struct({
  id: TrimmedNonEmptyString,
  machineId: MachineId,
  input: MachineCommandInput,
  delivery: CommandDelivery,
  actor: MapActor,
  status: CommandStatus,
  createdAt: MapTime,
  updatedAt: MapTime,
  expiresAt: MapTime,
  /** Command output for the portal, for example the diagnostics bundle or a test result. */
  result: Schema.NullOr(Schema.Unknown),
  error: Schema.NullOr(Schema.String),
});
export type MachineCommand = typeof MachineCommand.Type;

export const MachineClientSession = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  label: Schema.NullOr(Schema.String),
  subject: Schema.String,
  deviceType: Schema.NullOr(Schema.String),
  os: Schema.NullOr(Schema.String),
  browser: Schema.NullOr(Schema.String),
  connected: Schema.Boolean,
  lastSeenAt: Schema.NullOr(MapTime),
});
export type MachineClientSession = typeof MachineClientSession.Type;

/** MM-1002. */
export const MachineStatus = Schema.Struct({
  t3Version: Schema.String,
  /** Live commit, release version or deploy commit. */
  build: Schema.String,
  hostname: Schema.NullOr(TrimmedNonEmptyString),
  uptimeSeconds: Schema.Number,
  runningTurns: NonNegativeInt,
  waitingThreads: NonNegativeInt,
  scheduledTasks: NonNegativeInt,
  /** The version of a waiting update, or null. */
  updateWaiting: Schema.NullOr(Schema.String),
  cpuPercent: Schema.NullOr(Schema.Number),
  memoryPercent: Schema.NullOr(Schema.Number),
  commands: Schema.Array(MachineCommandKindSchema),
  clients: Schema.Array(MachineClientSession),
});
export type MachineStatus = typeof MachineStatus.Type;

export const MachinePresence = Schema.Struct({
  online: Schema.Boolean,
  lastSeenAt: Schema.NullOr(MapTime),
  appliedRevision: Schema.NullOr(NonNegativeInt),
  status: Schema.NullOr(MachineStatus),
});
export type MachinePresence = typeof MachinePresence.Type;

export const PeerMachine = Schema.Struct({
  id: MachineId,
  name: TrimmedNonEmptyString,
  kind: MachineKind,
  hostname: Schema.NullOr(TrimmedNonEmptyString),
  tokenClientId: TrimmedNonEmptyString,
});
export type PeerMachine = typeof PeerMachine.Type;

/** What one machine must apply (MM-603, MM-1202). */
export const MachineDesiredState = Schema.Struct({
  revision: NonNegativeInt,
  self: MachineRecord,
  peers: Schema.Array(PeerMachine),
  arrowsIn: Schema.Array(ArrowRecord),
  arrowsOut: Schema.Array(ArrowRecord),
  /** The shared values with this machine's overrides on top, for managed settings only. */
  settings: ScopedSettingValues,
});
export type MachineDesiredState = typeof MachineDesiredState.Type;

/** Agent tools that run through the portal (MM-801). `machine_tool_call` goes machine to machine. */
export const MapToolName = Schema.Literals([
  "machines_read",
  "machines_set_access",
  "machines_set_setting",
  "machines_command",
  "machines_queue_cancel",
  "machines_undo",
  "machines_preset",
]);
export type MapToolName = typeof MapToolName.Type;

export const MachineToPortal = Schema.Union([
  Schema.TaggedStruct("hello", {
    protocol: Schema.Literal(MACHINE_MAP_PROTOCOL),
    appliedRevision: Schema.NullOr(NonNegativeInt),
    status: MachineStatus,
    /** Current values of every setting, so the portal shows drift and can manage a key (MM-405, MM-406). */
    settings: ScopedSettingValues,
  }),
  Schema.TaggedStruct("status", { status: MachineStatus }),
  Schema.TaggedStruct("applied", { revision: NonNegativeInt }),
  /** MM-404: settings that changed on the machine, not through the map. */
  Schema.TaggedStruct("localSettings", { scope: SettingScope, values: SettingValues }),
  Schema.TaggedStruct("commandResult", {
    commandId: TrimmedNonEmptyString,
    ok: Schema.Boolean,
    result: Schema.NullOr(Schema.Unknown),
    error: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("toolCall", {
    requestId: TrimmedNonEmptyString,
    tool: MapToolName,
    input: Schema.Unknown,
    threadId: Schema.NullOr(Schema.String),
    threadTitle: Schema.NullOr(Schema.String),
  }),
  /** MM-207: the machine saved the new token secret. */
  Schema.TaggedStruct("rotated", { tokenClientId: TrimmedNonEmptyString }),
]);
export type MachineToPortal = typeof MachineToPortal.Type;

export const PortalToMachine = Schema.Union([
  Schema.TaggedStruct("desired", { state: MachineDesiredState }),
  Schema.TaggedStruct("command", { command: MachineCommand }),
  Schema.TaggedStruct("toolResult", {
    requestId: TrimmedNonEmptyString,
    ok: Schema.Boolean,
    result: Schema.NullOr(Schema.Unknown),
    error: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("rotate", {
    tokenClientId: TrimmedNonEmptyString,
    tokenSecret: TrimmedNonEmptyString,
  }),
]);
export type PortalToMachine = typeof PortalToMachine.Type;

/** Everything a portal page shows (MM-1102). */
export const PortalSnapshot = Schema.Struct({
  map: MachineMapDocument,
  presence: Schema.Record(Schema.String, MachinePresence),
  /** Current values that each machine reported, by machine id. */
  reportedSettings: Schema.Record(Schema.String, ScopedSettingValues),
  commands: Schema.Array(MachineCommand),
  history: Schema.Array(MapRevision),
  proposals: Schema.Array(MapProposal),
});
export type PortalSnapshot = typeof PortalSnapshot.Type;

export const PortalEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", { snapshot: PortalSnapshot }),
  Schema.TaggedStruct("revision", { revision: MapRevision, map: MachineMapDocument }),
  Schema.TaggedStruct("presence", { machineId: MachineId, presence: MachinePresence }),
  Schema.TaggedStruct("reportedSettings", { machineId: MachineId, settings: ScopedSettingValues }),
  Schema.TaggedStruct("command", { command: MachineCommand }),
  Schema.TaggedStruct("proposals", { proposals: Schema.Array(MapProposal) }),
]);
export type PortalEvent = typeof PortalEvent.Type;
