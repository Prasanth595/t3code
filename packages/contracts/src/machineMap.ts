/**
 * Fork: machine map. Shared types of the portal (`apps/machine-map`), the T3 server and the
 * desktop app. Requirement numbers (MM-xxx) refer to `apps/machine-map/SPEC.md`.
 */
import * as Effect from "effect/Effect";
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

const MapCoordinate = Schema.Number.check(Schema.isFinite());

/**
 * A place on the map. The portal writes fractions of the map area today. Any finite number
 * decodes, so a later portal can write map pixels without breaking machines on this build
 * (MM-1114): each machine decodes `self` in its desired state.
 */
export const MapPosition = Schema.Struct({ x: MapCoordinate, y: MapCoordinate });
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

/** A browser profile that the owner approved (MM-904). */
export const ClientId = TrimmedNonEmptyString.pipe(Schema.brand("ClientId"));
export type ClientId = typeof ClientId.Type;

/** One browser key of a client (MM-905): the JWK thumbprint of its DPoP key. */
const ClientKey = Schema.Struct({
  thumbprint: TrimmedNonEmptyString,
  addedAt: MapTime,
  /** The browser and system that the key came from, for example "Safari on iPhone". */
  describedAs: Schema.String,
});

export const ClientRecord = Schema.Struct({
  id: ClientId,
  name: TrimmedNonEmptyString,
  /** The Cloudflare Access email that the client signed in with. */
  email: Schema.NullOr(TrimmedNonEmptyString),
  keys: Schema.Array(ClientKey),
  position: MapPosition,
  createdAt: MapTime,
});
export type ClientRecord = typeof ClientRecord.Type;

/**
 * MM-906: the short code of a browser key, for example `K7-PQ-3M`. The waiting browser and the
 * portal both show it, so the owner can tell that they approve the right sign-in.
 */
export const clientKeyCode = (thumbprint: string): string => {
  const letters = thumbprint.slice(0, 6).toUpperCase();
  return [letters.slice(0, 2), letters.slice(2, 4), letters.slice(4, 6)].join("-");
};

/** What one client can do on one machine (MM-309). A client never gets agent tools. */
export const ClientArrowRecord = Schema.Struct({
  client: ClientId,
  to: MachineId,
  level: MachineLevel,
  /** MM-304: at this time the arrow returns to `revertLevel`. */
  expiresAt: Schema.NullOr(MapTime),
  revertLevel: Schema.NullOr(MachineLevel),
});
export type ClientArrowRecord = typeof ClientArrowRecord.Type;

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

/**
 * MM-406: settings that belong to one machine. They never become map entries: a machine does not
 * report them, the portal refuses a value for them, and a machine never applies one.
 */
const MACHINE_LOCAL_SETTINGS: Readonly<Record<SettingScope, ReadonlySet<string>>> = {
  server: new Set([
    // The connection to the portal itself: a shared value could cut it.
    "machineMap",
    // Secrets: a machine reports them redacted, so a shared value would erase them.
    "providerInstances",
    "sourceControlHosts",
    "usageLimitSources",
    // Paths on the file system of this machine.
    "worktreesDirectory",
    "previousWorktreesDirectories",
    "addProjectBaseDirectory",
    // Keyed by project id. A project id is local to one environment.
    "projectSettingsOverrides",
    "projectScriptOverrides",
    "pinnedProjectScriptIds",
    "projectAutoPullOverrides",
    "projectAgentBrowserAccessOverrides",
    // SSH hosts and the device setup of this machine.
    "deviceHosts",
    "deviceOnboardingCompleted",
    // Uses the keychain of this machine.
    "cursorKeychainUsageEnabled",
    // The icon that tells this machine apart from the others.
    "environmentIcon",
    // The time of the last local theme change (MM-408).
    "defaultThemeSetAt",
  ]),
  client: new Set([
    // State of this app, not a preference.
    "onboardingCompletedAt",
    "dismissedProviderUpdateNotificationKeys",
    // Browser profiles point to data folders on this machine.
    "browserProfiles",
    "browserDefaultProfileId",
  ]),
};

export const isMachineLocalSetting = (scope: SettingScope, key: string): boolean =>
  MACHINE_LOCAL_SETTINGS[scope].has(key);

export const withoutMachineLocalSettings = (
  scope: SettingScope,
  values: Readonly<Record<string, unknown>>,
): SettingValues =>
  Object.fromEntries(Object.entries(values).filter(([key]) => !isMachineLocalSetting(scope, key)));

/** MM-406: a key is shared when it has a shared value. Older maps also hold `managed`, which decodes away. */
export const MapSettings = Schema.Struct({
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

/**
 * Where the owner put the card of a pair (MM-1108), relative to the line from machine `a` to
 * machine `b`, so the card follows when the machines move.
 */
export const PairOffset = Schema.Struct({
  /** 0 is the center of `a`, 1 the center of `b`. */
  along: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  /** Distance beside the line, as a fraction of the shorter side of the map. Any finite number decodes, see `MapPosition`. */
  aside: MapCoordinate,
});
export type PairOffset = typeof PairOffset.Type;

/** A stored pair placement. `a` sorts before `b`. */
export const PairPlacement = Schema.Struct({ a: MachineId, b: MachineId, ...PairOffset.fields });
export type PairPlacement = typeof PairPlacement.Type;

export const NoteColor = Schema.Literals(["yellow", "pink", "blue", "green"]);
export type NoteColor = typeof NoteColor.Type;

/** A sticky note on the map (MM-1109). */
export const MapNote = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  color: NoteColor,
  position: MapPosition,
});
export type MapNote = typeof MapNote.Type;

export const MachineMapDocument = Schema.Struct({
  revision: NonNegativeInt,
  machines: Schema.Array(MachineRecord),
  arrows: Schema.Array(ArrowRecord),
  settings: MapSettings,
  presets: Schema.Array(MapPreset),
  /** Display data (MM-1108, MM-1109): no machine applies it. Older maps decode with none. */
  pairPlacements: Schema.Array(PairPlacement).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  notes: Schema.Array(MapNote).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** MM-904. Older maps decode with none. */
  clients: Schema.Array(ClientRecord).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** MM-309: only arrows above the default `none` are stored. */
  clientArrows: Schema.Array(ClientArrowRecord).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
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
  Schema.TaggedStruct("putMachine", { machine: MachineRecord }),
  Schema.TaggedStruct("removeMachine", { machineId: MachineId }),
  Schema.TaggedStruct("putPreset", { preset: MapPreset }),
  Schema.TaggedStruct("removePreset", { name: TrimmedNonEmptyString }),
  /** MM-1108: null returns the card of the pair to its automatic place. */
  Schema.TaggedStruct("placePair", {
    a: MachineId,
    b: MachineId,
    offset: Schema.NullOr(PairOffset),
  }),
  Schema.TaggedStruct("putNote", { note: MapNote }),
  Schema.TaggedStruct("removeNote", { id: TrimmedNonEmptyString }),
  Schema.TaggedStruct("putClient", { client: ClientRecord }),
  Schema.TaggedStruct("removeClient", { clientId: ClientId }),
  /** MM-907: only an approval adds a key. No owner change and no undo can add one. */
  Schema.TaggedStruct("addClientKey", { clientId: ClientId, key: ClientKey }),
  /** MM-909: removes one browser key. Its undo refuses, because the inverse adds a key. */
  Schema.TaggedStruct("removeClientKey", { clientId: ClientId, thumbprint: TrimmedNonEmptyString }),
  Schema.TaggedStruct("setClientArrow", { arrow: ClientArrowRecord }),
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
  Schema.TaggedStruct("restartServer", {}).annotate({
    description: "Restart the T3 server. Its supervisor starts it again. Running agent turns stop.",
  }),
  Schema.TaggedStruct("installUpdate", {
    whenIdle: Schema.Boolean.annotate({
      description: "True waits until no agent runs on the machine. False installs now.",
    }),
  }).annotate({
    description:
      "Install what the desktop update button offers: an app update or a ready live build. Desktop machines only, while the app runs.",
  }),
  Schema.TaggedStruct("stopAllAgents", {}).annotate({
    description: "Interrupt every running agent turn on the machine.",
  }),
  Schema.TaggedStruct("pauseScheduledTasks", {}).annotate({
    description: "Pause every scheduled task on the machine.",
  }),
  Schema.TaggedStruct("resumeScheduledTasks", {}).annotate({
    description: "Resume the scheduled tasks of the machine.",
  }),
  Schema.TaggedStruct("setScheduledTaskEnabled", {
    taskId: TrimmedNonEmptyString.annotate({
      description: "Task id from presence.<machineId>.status.tasks in machines_read.",
    }),
    enabled: Schema.Boolean.annotate({ description: "False pauses the task. True resumes it." }),
  }).annotate({
    description:
      "Pause or resume one scheduled task on the machine. taskId comes from presence.<machineId>.status.tasks in machines_read.",
  }),
  Schema.TaggedStruct("runScheduledTask", {
    taskId: TrimmedNonEmptyString.annotate({
      description: "Task id from presence.<machineId>.status.tasks in machines_read.",
    }),
  }).annotate({
    description: "Run one scheduled task on the machine now, like its Run now button.",
  }),
  Schema.TaggedStruct("reloadWindows", {}).annotate({
    description: "Reload the desktop app windows. Desktop machines only.",
  }),
  Schema.TaggedStruct("startThread", {
    projectId: TrimmedNonEmptyString.annotate({
      description: "Project id on the target machine. Read it there with t3_project_list.",
    }),
    title: TrimmedNonEmptyString.annotate({ description: "Title of the new thread." }),
    message: TrimmedNonEmptyString.annotate({ description: "First message to the agent." }),
  }).annotate({
    description:
      "Start a thread on the machine, like t3_thread_launch there. projectId is a project id on that machine (t3_project_list there); title and message are text.",
  }),
  Schema.TaggedStruct("revokeClient", {
    sessionId: TrimmedNonEmptyString.annotate({
      description: "Client session id from presence.<machineId>.status.clients in machines_read.",
    }),
  }).annotate({
    description:
      "End one client session on the machine. sessionId comes from presence.<machineId>.status.clients in machines_read.",
  }),
  Schema.TaggedStruct("collectDiagnostics", {}).annotate({
    description:
      "Collect versions, recent errors, processes and resource use. The bundle is the command result.",
  }),
  Schema.TaggedStruct("testArrow", {
    to: MachineId.annotate({ description: "Target machine id of the arrow to test." }),
  }).annotate({
    description:
      "Connect from the machine to the machine id `to` and report reachability, round trip time and scopes.",
  }),
]);
export type MachineCommandInput = typeof MachineCommandInput.Type;
export type MachineCommandKind = MachineCommandInput["_tag"];

export const MachineCommandKindSchema = Schema.Literals([
  "restartServer",
  "installUpdate",
  "stopAllAgents",
  "pauseScheduledTasks",
  "resumeScheduledTasks",
  "setScheduledTaskEnabled",
  "runScheduledTask",
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

/** MM-1601: one scheduled task as the portal shows it. */
export const MachineScheduledTask = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.String,
  enabled: Schema.Boolean,
  /** The schedule in words, for example "Every 1 hour" or "Weekdays at 09:00". */
  schedule: Schema.String,
  nextRunAt: Schema.NullOr(MapTime),
  lastRunAt: Schema.NullOr(MapTime),
  lastRunStatus: Schema.NullOr(Schema.String),
  lastRunError: Schema.NullOr(Schema.String),
});
export type MachineScheduledTask = typeof MachineScheduledTask.Type;

/** MM-1002. */
export const MachineStatus = Schema.Struct({
  t3Version: Schema.String,
  /** `<kind> <commit>`: `live`, `deploy` or `dev` with a 7-character commit, or `release`. */
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
  /** MM-1601: absent on machines that do not report their tasks yet. */
  tasks: Schema.optionalKey(Schema.Array(MachineScheduledTask)),
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

/**
 * MM-213: the tunnel that "Add machine" made for a machine. `/enroll` delivers it once. The token
 * runs `cloudflared` (MM-1309). The Access values are the Cloudflare Access login of the server.
 */
export const MachineTunnelGrant = Schema.Struct({
  hostname: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
  access: Schema.Struct({
    teamDomain: TrimmedNonEmptyString,
    aud: TrimmedNonEmptyString,
    subjects: Schema.NonEmptyArray(TrimmedNonEmptyString),
  }),
});
export type MachineTunnelGrant = typeof MachineTunnelGrant.Type;

/** What one machine must apply (MM-603, MM-1202). */
export const MachineDesiredState = Schema.Struct({
  revision: NonNegativeInt,
  self: MachineRecord,
  peers: Schema.Array(PeerMachine),
  arrowsIn: Schema.Array(ArrowRecord),
  arrowsOut: Schema.Array(ArrowRecord),
  /** The shared values with this machine's overrides on top. Keys without a value are absent. */
  settings: ScopedSettingValues,
  /** MM-718: true while the emergency pause is on. The machine then locks every client except its own desktop app. Absent means false. */
  paused: Schema.optionalKey(Schema.Boolean),
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
  "machines_resources",
]);
export type MapToolName = typeof MapToolName.Type;

export const MachineToPortal = Schema.Union([
  Schema.TaggedStruct("hello", {
    protocol: Schema.Literal(MACHINE_MAP_PROTOCOL),
    appliedRevision: Schema.NullOr(NonNegativeInt),
    status: MachineStatus,
    /** Current values of every setting but the machine-local ones (MM-405, MM-406). */
    settings: ScopedSettingValues,
  }),
  Schema.TaggedStruct("status", { status: MachineStatus }),
  Schema.TaggedStruct("applied", { revision: NonNegativeInt }),
  /**
   * MM-404: settings that changed on the machine, not through the map. MM-411: `shared` is true
   * for a change made in T3 Settings for all environments.
   */
  Schema.TaggedStruct("localSettings", {
    scope: SettingScope,
    values: SettingValues,
    shared: Schema.optionalKey(Schema.Boolean),
  }),
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
  /** MM-906: a browser key that no client holds signed in through Cloudflare Access. */
  Schema.TaggedStruct("clientSeen", {
    thumbprint: TrimmedNonEmptyString,
    describedAs: Schema.String.check(Schema.isMaxLength(200)),
    email: Schema.NullOr(TrimmedNonEmptyString),
  }),
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
  /**
   * MM-1120: the unit of map places. A page decodes only the unit of its own bundle, so a
   * snapshot in a newer unit fails to decode and the page loads the new bundle.
   */
  placeUnits: Schema.Literal("fractions"),
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

const PositiveInt = NonNegativeInt.check(Schema.isGreaterThan(0));

/**
 * Inputs of the agent tools that run through the portal (MM-801). The T3 server declares its MCP
 * tools with these schemas, and the portal decodes `toolCall.input` with the same ones.
 */
export const MapToolInputs = {
  machines_read: Schema.Struct({}),
  machines_set_access: Schema.Struct({
    from: MachineId.annotate({ description: "Id of the machine that gets access." }),
    to: MachineId.annotate({ description: "Id of the machine that it gets access to." }),
    level: MachineLevel.annotate({
      description:
        "none: no access. read: read threads, files, terminals and diagnostics. standard: a normal client, which also changes settings. admin: standard plus client access and relay management.",
    }),
    agentTools: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          "True lets agents on `from` call T3 tools on `to` with machine_tool_call. Omit to keep the current value.",
      }),
    ),
    expiresInMinutes: Schema.optionalKey(
      PositiveInt.annotate({
        description:
          "Minutes until the arrow returns to its current permanent level. Omit for a permanent change.",
      }),
    ),
  }),
  machines_set_setting: Schema.Struct({
    machineId: Schema.optionalKey(
      MachineId.annotate({
        description: "Machine to override. Omit to set the shared value of every machine.",
      }),
    ),
    scope: SettingScope.annotate({
      description:
        "server: T3 server settings (settings.json). client: desktop app client settings.",
    }),
    key: TrimmedNonEmptyString.annotate({
      description:
        "Top-level settings key, for example recoverInterruptedTurns. Any key works except the machine-local ones, such as paths, secrets and machineMap.",
    }),
    value: Schema.optionalKey(
      Schema.Unknown.annotate({
        description:
          "New value, in the type of the settings schema. Omit to clear: the machine follows the shared value again.",
      }),
    ),
    clear: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "True removes the value, also when `value` is set.",
      }),
    ),
  }),
  machines_command: Schema.Struct({
    machineId: MachineId.annotate({ description: "Id of the machine that runs the command." }),
    command: MachineCommandInput.annotate({
      description:
        'The command, tagged by `_tag`, for example {"_tag":"stopAllAgents"}. The machine must list the tag in presence.<machineId>.status.commands.',
    }),
    delivery: Schema.optionalKey(
      CommandDelivery.annotate({
        description:
          "online (default): run when the machine is connected. idle: also wait until no agent runs there.",
      }),
    ),
    expiresInMinutes: Schema.optionalKey(
      PositiveInt.annotate({
        description: "Minutes until a queued command expires. Default 1440 (24 hours).",
      }),
    ),
  }),
  machines_queue_cancel: Schema.Struct({
    commandId: TrimmedNonEmptyString.annotate({
      description: "Id of a command with status queued, from `commands` in machines_read.",
    }),
  }),
  machines_undo: Schema.Struct({
    revision: NonNegativeInt.annotate({
      description: "Revision number to undo, from `history` in machines_read.",
    }),
  }),
  machines_preset: Schema.Struct({
    action: Schema.Literals(["save", "apply"]).annotate({
      description:
        "save: store the current arrows as preset `name`. apply: set every arrow from preset `name`.",
    }),
    name: TrimmedNonEmptyString.annotate({ description: "Preset name." }),
  }),
  /** MM-1507: the resource history of one machine. The range defaults to `hour`. */
  machines_resources: Schema.Struct({
    machineId: MachineId,
    range: Schema.optionalKey(Schema.Literals(["hour", "day", "month"])),
  }),
} satisfies Record<MapToolName, Schema.Top>;
