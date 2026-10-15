/**
 * Fork: machine map, the contract between a T3 server and its own clients (desktop app and web
 * Settings). The portal protocol is in `machineMap.ts`. Requirement numbers (MM-xxx) refer to
 * `apps/machine-map/SPEC.md`.
 *
 * A client subscribes to `machineMap.subscribe` and gets the whole state again on each change.
 * The local desktop app also gets `tokenHeaders`, runs `desktopCommands`, and reports back with
 * `machineMap.reportDesktop`.
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  MachineCommand,
  MachineDesiredState,
  MachineLevel,
  MachineMapDocument,
  MachinePresence,
  MapTime,
  PeerMachine,
  SettingValues,
} from "./machineMap.ts";
import { HealthAlert, ResourcesOverview } from "./machineMapResources.ts";

/**
 * - `off`: the `machineMap` setting is off.
 * - `not-joined`: the setting is on, but no machine token is saved. Join with a code.
 * - `connecting`: the server dials the portal, or waits before the next attempt.
 * - `online`: the portal connection is open.
 */
export const MachineMapConnectionStatus = Schema.Literals([
  "off",
  "not-joined",
  "connecting",
  "online",
]);
export type MachineMapConnectionStatus = typeof MachineMapConnectionStatus.Type;

export const MachineMapConnection = Schema.Struct({
  status: MachineMapConnectionStatus,
  /** When the connection entered this status. */
  since: MapTime,
  /** Why the last attempt failed, while `connecting`. Never a secret. */
  lastError: Schema.NullOr(Schema.String),
  /** Failed attempts since the last open connection. */
  failedAttempts: NonNegativeInt,
});
export type MachineMapConnection = typeof MachineMapConnection.Type;

/**
 * The machine token as request headers. Cloudflare Access accepts them on the hostname of every
 * machine that has an arrow from this machine (MM-306).
 */
export const MachineMapTokenHeaders = Schema.Struct({
  "CF-Access-Client-Id": TrimmedNonEmptyString,
  "CF-Access-Client-Secret": TrimmedNonEmptyString,
});
export type MachineMapTokenHeaders = typeof MachineMapTokenHeaders.Type;

/** A peer that this machine can use: its arrow is above `none` and its hostname is known. */
export const MachineMapReachablePeer = Schema.Struct({
  machine: PeerMachine,
  level: MachineLevel,
  agentTools: Schema.Boolean,
  /** `https://<hostname>`, the T3 server of the peer behind its tunnel. */
  origin: TrimmedNonEmptyString,
});
export type MachineMapReachablePeer = typeof MachineMapReachablePeer.Type;

export const MachineMapClientState = Schema.Struct({
  enabled: Schema.Boolean,
  portalUrl: TrimmedNonEmptyString,
  /** A machine token is saved. */
  joined: Schema.Boolean,
  connection: MachineMapConnection,
  /** The last desired state that this machine applied, or null before the first one. */
  desired: Schema.NullOr(MachineDesiredState),
  /** MM-306, MM-1401: the desktop app keeps one saved environment for each of these. */
  reachable: Schema.Array(MachineMapReachablePeer),
  /**
   * Only for the local desktop app (a `desktop-bootstrap` session). Null for every other client,
   * and while no token is saved.
   */
  tokenHeaders: Schema.NullOr(MachineMapTokenHeaders),
  /**
   * MM-1402: commands that only the desktop app can run (`installUpdate`, `reloadWindows`). They
   * wait here until a desktop app reports their result. Empty for every client but the desktop.
   */
  desktopCommands: Schema.Array(MachineCommand),
});
export type MachineMapClientState = typeof MachineMapClientState.Type;

export const MachineMapJoinInput = Schema.Struct({
  code: TrimmedNonEmptyString.annotate({
    description:
      "One-time join code from Add machine in the portal, for example K7QM-2XPA. It works once.",
  }),
  portalUrl: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({
      description:
        "Portal origin, for example https://t3.yarden-zamir.com. Omit to keep the portal of the machineMap setting.",
    }),
  ),
});
export type MachineMapJoinInput = typeof MachineMapJoinInput.Type;

export const MachineMapDesktopCommandResult = Schema.Struct({
  commandId: TrimmedNonEmptyString,
  ok: Schema.Boolean,
  result: Schema.NullOr(Schema.Unknown),
  error: Schema.NullOr(Schema.String),
});
export type MachineMapDesktopCommandResult = typeof MachineMapDesktopCommandResult.Type;

/** What the local desktop app reports. Each omitted field keeps its last reported value. */
export const MachineMapDesktopReport = Schema.Struct({
  commandResult: Schema.optionalKey(MachineMapDesktopCommandResult),
  /** The version of the desktop update that waits to install, or null when none waits. */
  updateWaiting: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The build the desktop app runs (MM-1002). Null for the release. */
  build: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The current client settings of the desktop app (MM-403, MM-404, MM-405). */
  clientSettings: Schema.optionalKey(SettingValues),
});
export type MachineMapDesktopReport = typeof MachineMapDesktopReport.Type;

/**
 * MM-411: a change that T3 Settings saved for all environments. The server sends the saved values
 * of `server` and the given `client` values to the portal as shared values.
 */
export const MachineMapShareSettingsInput = Schema.Struct({
  /** Server settings keys. The server reads their saved values. */
  server: Schema.Array(Schema.String),
  client: SettingValues,
});
export type MachineMapShareSettingsInput = typeof MachineMapShareSettingsInput.Type;

/** False when this machine is not on the map or not connected: the change stays a bulk edit. */
export const MachineMapShareSettingsResult = Schema.Struct({ shared: Schema.Boolean });
export type MachineMapShareSettingsResult = typeof MachineMapShareSettingsResult.Type;

/**
 * MM-1701: an alert as the Machines panel reads it. The kind is an open string, so an alert kind
 * that a newer portal adds does not break the panel of this build.
 */
const PanelHealthAlert = Schema.Struct({ ...HealthAlert.fields, kind: Schema.String });

/** MM-1701: the part of a `machines_read` result that the Machines panel shows. */
export const MachinesReadResult = Schema.TaggedStruct("read", {
  map: MachineMapDocument,
  presence: Schema.Record(Schema.String, MachinePresence),
  commands: Schema.Array(MachineCommand),
  resources: Schema.Struct({ ...ResourcesOverview.fields, alerts: Schema.Array(PanelHealthAlert) }),
});
export type MachinesReadResult = typeof MachinesReadResult.Type;

/**
 * MM-1701: what the Machines panel gets. `unavailable` says why there is no map:
 * - `off`: the `machineMap` setting is off or no machine token is saved.
 * - `paused`: the emergency pause is on, and the portal refuses `machines_read` (MM-711).
 * - `not-connected`, `timed-out`, `refused`: the portal call failed.
 * - `unreadable`: the portal answered with a result that this server does not understand.
 */
export const MachineMapPanelState = Schema.Union([
  MachinesReadResult,
  Schema.TaggedStruct("unavailable", {
    reason: Schema.Literals([
      "off",
      "paused",
      "not-connected",
      "timed-out",
      "refused",
      "unreadable",
    ]),
    /** A message safe to show. Never a secret. */
    detail: Schema.String,
  }),
]);
export type MachineMapPanelState = typeof MachineMapPanelState.Type;

export class MachineMapRequestError extends Schema.TaggedError<MachineMapRequestError>()(
  "MachineMapRequestError",
  {
    reason: Schema.Literals([
      "portal-unreachable",
      "join-refused",
      "desktop-only",
      "storage-failed",
      "settings-failed",
    ]),
    /** A message safe to show, such as the refusal of the portal. Never a secret. */
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Machine map (${this.reason}): ${this.detail}`;
  }
}
