/**
 * Request and response shapes of the portal HTTP API. The Worker decodes requests with these
 * schemas, and the page uses the same types. The machine protocol lives in
 * `@t3tools/contracts/machineMap`.
 */
import * as Schema from "effect/Schema";

import {
  CommandDelivery,
  MachineCommandInput,
  MachineId,
  MachineKind,
  MapActor,
  MapChange,
  MapPosition,
  type MachineCommand,
  type MachineMapDocument,
  type MachinePresence,
  type MapProposal,
  type MapRevision,
} from "@t3tools/contracts/machineMap";
import {
  HealthThresholds,
  ResourceSample,
  ResourcesOverview,
  type HealthAlert,
  type ResourceHistory,
} from "@t3tools/contracts/machineMapResources";

const Text = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty());
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** POST /api/changes: one revision from the owner. */
export const ChangesRequest = Schema.Struct({
  summary: Text,
  changes: Schema.Array(MapChange).check(Schema.isMinLength(1)),
});
export type ChangesRequest = typeof ChangesRequest.Type;

/** POST /api/commands (MM-501, MM-605). */
export const CommandRequest = Schema.Struct({
  machineId: MachineId,
  input: MachineCommandInput,
  delivery: CommandDelivery,
  expiresInMinutes: PositiveInt,
});
export type CommandRequest = typeof CommandRequest.Type;

/** POST /api/undo and POST /api/restore. */
export const RevisionRequest = Schema.Struct({ revision: NonNegativeInt });
export type RevisionRequest = typeof RevisionRequest.Type;

/**
 * POST /api/machines (MM-201, MM-210). With the Cloudflare API token, the portal creates the
 * machine token. Without it, the owner gives the id and secret of an existing machine token.
 */
export const AddMachineRequest = Schema.Struct({
  name: Text,
  kind: MachineKind,
  /** MM-1110: the place that the owner picked. Omit for the free spot of MM-206. */
  position: Schema.optionalKey(MapPosition),
  tokenClientId: Schema.optionalKey(Text),
  tokenSecret: Schema.optionalKey(Text),
});
export type AddMachineRequest = typeof AddMachineRequest.Type;

/** POST /api/machines/:id/join-code. Without the Cloudflare API token, the secret is required. */
export const JoinCodeRequest = Schema.Struct({ tokenSecret: Schema.optionalKey(Text) });
export type JoinCodeRequest = typeof JoinCodeRequest.Type;

/** POST /enroll (MM-204). No Access JWT: the join code is the credential. */
export const EnrollRequest = Schema.Struct({ code: Text });
export type EnrollRequest = typeof EnrollRequest.Type;

export interface EnrollResponse {
  readonly machineId: MachineId;
  readonly name: string;
  readonly kind: MachineKind;
  readonly tokenClientId: string;
  readonly tokenSecret: string;
}

export interface JoinCodeResponse {
  readonly machineId: MachineId;
  readonly code: string;
  readonly expiresAt: string;
}

/** The result of a write: applied as a revision, or waiting in the Inbox (MM-804). */
export type WriteResult =
  | { readonly _tag: "applied"; readonly revision: number }
  | {
      readonly _tag: "proposed";
      readonly proposalId: string;
      readonly reason: MapProposal["reason"];
    };

/** GET /api/history?before&limit: newest first. */
export interface HistoryResponse {
  readonly revisions: ReadonlyArray<MapRevision>;
}

/** GET /api/map-at?revision (MM-704). */
export interface MapAtResponse {
  readonly map: MachineMapDocument;
}

/** A browser that opened the portal, as the portal saw it (MM-901). */
export interface PortalSignIn {
  readonly id: string;
  readonly device: string;
  readonly browser: string;
  readonly place: string;
  readonly firstSeenAt: string;
  readonly lastUsedAt: string;
}

/** An owner session in Cloudflare Access (MM-901). Cloudflare does not report the browser. */
export interface AccessSession {
  readonly name: string;
  readonly country: string | null;
  readonly ip: string | null;
  readonly signedInAt: string | null;
  readonly expiresAt: string | null;
}

/** GET /api/devices. */
export interface DevicesResponse {
  readonly portalSignIns: ReadonlyArray<PortalSignIn>;
  readonly access:
    | { readonly _tag: "available"; readonly sessions: ReadonlyArray<AccessSession> }
    | { readonly _tag: "unavailable"; readonly message: string };
}

/** POST /api/devices/sign-out-everywhere (MM-903). */
export interface SignOutEverywhereResponse {
  /** Null when Cloudflare Access sessions ended. Otherwise the reason they did not. */
  readonly accessMessage: string | null;
  readonly revokeCommands: number;
}

/** DELETE /api/machines/:id (MM-208). Without the Cloudflare API token, the token stays in Cloudflare. */
export interface RemoveMachineResponse {
  readonly machineId: MachineId;
  readonly tokenDeleted: boolean;
}

/** POST /api/machines/:id/rotate (MM-207). */
export interface RotationResponse {
  readonly machineId: MachineId;
  readonly delivered: boolean;
}

/** A token rotation that waits for its machine (MM-207). The secret never leaves the portal. */
export interface PendingRotation {
  readonly machineId: MachineId;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * Page events. The portal sends `PortalEvent` from the contracts, plus this event for pending
 * token rotations, which `PortalSnapshot` does not hold.
 */
export interface RotationsEvent {
  readonly _tag: "rotations";
  readonly rotations: ReadonlyArray<PendingRotation>;
}

/**
 * MM-713: the emergency pause as every page shows it. Only the owner pauses, so `by` is always
 * an owner. `revision` is null when the map was already locked down.
 */
export const PauseState = Schema.Struct({
  pausedAt: Text,
  by: MapActor,
  revision: Schema.NullOr(NonNegativeInt),
});
export type PauseState = typeof PauseState.Type;

/** Page event: the pause began (`pause` set) or ended (`pause` null). */
export const PauseEvent = Schema.TaggedStruct("pause", { pause: Schema.NullOr(PauseState) });
export type PauseEvent = typeof PauseEvent.Type;

/** POST /api/pause (MM-708 to MM-710). */
export interface PauseResponse {
  readonly pause: PauseState;
  readonly stopCommands: number;
}

/** POST /api/resume (MM-712). `revision` is null when nothing had to change. */
export interface ResumeResponse {
  readonly revision: number | null;
}

/**
 * MM-1506: page event with the whole health state, on connection and on each alert or threshold
 * change. `alerts` holds the active alerts and the newest ended ones.
 */
export const HealthEvent = Schema.TaggedStruct("health", { health: ResourcesOverview });
export type HealthEvent = typeof HealthEvent.Type;

/** MM-1506: page event for each new sample of a machine. */
export const ResourceSampleEvent = Schema.TaggedStruct("resourceSample", {
  machineId: MachineId,
  sample: ResourceSample,
});
export type ResourceSampleEvent = typeof ResourceSampleEvent.Type;

/** POST /api/machines/:id/thresholds (MM-1504). Null returns the machine to the defaults. */
export const ThresholdsRequest = Schema.Struct({ thresholds: Schema.NullOr(HealthThresholds) });
export type ThresholdsRequest = typeof ThresholdsRequest.Type;

/** POST /api/machines/:id/sample (MM-1501). False when the machine is offline or just sampled. */
export interface SampleResponse {
  readonly requested: boolean;
}

/** Every error response has this shape. */
export interface ApiError {
  readonly error: string;
}

/** Results of the agent tools that run through the portal (`toolResult.result`, MM-801). */
export type MapToolResult =
  | {
      readonly _tag: "read";
      readonly map: MachineMapDocument;
      readonly presence: Readonly<Record<string, MachinePresence>>;
      readonly commands: ReadonlyArray<MachineCommand>;
      readonly history: ReadonlyArray<MapRevision>;
      readonly proposals: ReadonlyArray<MapProposal>;
      /** MM-1507: the latest samples, the thresholds and the active alerts. */
      readonly resources: ResourcesOverview;
    }
  | {
      readonly _tag: "resources";
      readonly history: ResourceHistory;
      /** The alerts of the machine that started or ended within the range. */
      readonly alerts: ReadonlyArray<HealthAlert>;
    }
  | WriteResult
  | { readonly _tag: "command"; readonly command: MachineCommand };
