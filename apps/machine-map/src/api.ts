/**
 * Request and response shapes of the portal HTTP API. The Worker decodes requests with these
 * schemas, and the page uses the same types. The machine protocol lives in
 * `@t3tools/contracts/machineMap`.
 */
import * as Schema from "effect/Schema";

import {
  ClientId,
  CommandDelivery,
  MachineCommandInput,
  MachineId,
  MachineKind,
  MachineLevel,
  MapActor,
  MapChange,
  MapPosition,
  type MachineCommand,
  type MachineMapDocument,
  type MachineTunnelGrant,
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
  /** MM-213: null for a machine without a portal tunnel. */
  readonly tunnel: MachineTunnelGrant | null;
}

/** MM-213: what the portal did about the tunnel of a machine. */
export type TunnelSetup =
  | { readonly status: "ready"; readonly hostname: string }
  | { readonly status: "skipped"; readonly reason: string };

export interface JoinCodeResponse {
  readonly machineId: MachineId;
  readonly code: string;
  readonly expiresAt: string;
  /** Null when the code carries no tunnel, for example a new code of a machine without one. */
  readonly tunnel: TunnelSetup | null;
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
  /** Push subscriptions that the sign-out deleted. */
  readonly pushRemoved: number;
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
 * an owner. `revision` is null when every arrow, client arrow and map role was `none` already.
 */
export const PauseState = Schema.Struct({
  pausedAt: Text,
  by: MapActor,
  revision: Schema.NullOr(NonNegativeInt),
});
export type PauseState = typeof PauseState.Type;

/** MM-717: an arrow that the pause set to `none`, with its level from before the pause. */
const CutArrow = Schema.Struct({ from: MachineId, to: MachineId, level: MachineLevel });
type CutArrow = typeof CutArrow.Type;

/** MM-717: a client arrow that the pause set to `none`. */
const CutClientArrow = Schema.Struct({
  client: ClientId,
  to: MachineId,
  level: MachineLevel,
});

/** The pause as pages see it: the stored state plus the arrows it cut (MM-717). */
export const PauseView = Schema.Struct({
  ...PauseState.fields,
  cut: Schema.Array(CutArrow),
  cutClients: Schema.Array(CutClientArrow),
});
export type PauseView = typeof PauseView.Type;

/** Page event: the pause began (`pause` set) or ended (`pause` null). */
export const PauseEvent = Schema.TaggedStruct("pause", { pause: Schema.NullOr(PauseView) });
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

/** MM-212: page event when a machine used its join code. It holds no part of the code. */
export const EnrolledEvent = Schema.TaggedStruct("enrolled", { machineId: MachineId });
export type EnrolledEvent = typeof EnrolledEvent.Type;

/** MM-906: a browser key that signed in and waits for the owner, or that the owner rejected. */
export const PendingClient = Schema.Struct({
  thumbprint: Text,
  describedAs: Schema.String,
  email: Schema.NullOr(Text),
  /** The machine that reported the sign-in. */
  seenOn: MachineId,
  firstSeenAt: Text,
  lastSeenAt: Text,
  state: Schema.Literals(["pending", "rejected"]),
});
export type PendingClient = typeof PendingClient.Type;

/** Page event with every waiting and rejected key, on connection and on each change. */
export const PendingClientsEvent = Schema.TaggedStruct("pendingClients", {
  pending: Schema.Array(PendingClient),
});
export type PendingClientsEvent = typeof PendingClientsEvent.Type;

/**
 * POST /api/grant/approve (MM-907): the key joins a new client or an existing one. The arrows
 * of a new client start at `none` unless listed.
 */
export const ApproveClientRequest = Schema.Struct({
  thumbprint: Text,
  client: Schema.Union([
    Schema.TaggedStruct("new", { name: Text }),
    Schema.TaggedStruct("existing", { clientId: ClientId }),
  ]),
  arrows: Schema.Array(Schema.Struct({ to: MachineId, level: MachineLevel })),
});
export type ApproveClientRequest = typeof ApproveClientRequest.Type;

/**
 * POST /api/grant/invite (MM-913): an invite for a native app, into a new client with these
 * arrows or into an existing client with its own arrows. A new invite ends the older ones.
 */
export const InviteRequest = Schema.Struct({
  client: ApproveClientRequest.fields.client,
  arrows: ApproveClientRequest.fields.arrows,
});
export type InviteRequest = typeof InviteRequest.Type;

/** MM-913: a waiting invite of a native app, without its code. */
export const ClientInvite = Schema.Struct({ clientId: ClientId, expiresAt: Text });
export type ClientInvite = typeof ClientInvite.Type;

/** Page event with every waiting invite, on connection and on each change. */
export const ClientInvitesEvent = Schema.TaggedStruct("clientInvites", {
  invites: Schema.Array(ClientInvite),
});
export type ClientInvitesEvent = typeof ClientInvitesEvent.Type;

export interface InviteResponse {
  readonly clientId: ClientId;
  /** The QR and the link: `https://<portal>/enroll/client#code=<code>`. */
  readonly url: string;
  readonly expiresAt: string;
}

/** GET /api/clients/approvals (MM-1208): whether approvals work, and why not. */
export type ApprovalsStatus =
  /** `warning` names a token permission that another owner action needs, for example MM-903. */
  | { readonly _tag: "ready"; readonly warning: string | null }
  | { readonly _tag: "missing"; readonly reason: string };

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
  /** MM-1207: the approval path needs a fresh passkey check first. */
  readonly stepUp?: true;
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

export const FORK_RELEASES_PAGE = "https://github.com/Yarden-zamir/t3code/releases";

/** GET /api/fork-release: the newest nightly of the fork (MM-211). */
export interface ForkRelease {
  /** Null when GitHub did not answer. The page then links to `pageUrl` only. */
  readonly tag: string | null;
  readonly version: string | null;
  readonly pageUrl: string;
  readonly macUrl: string | null;
  readonly windowsUrl: string | null;
}

const Base64Url = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));

/** POST /api/push/subscribe: the `toJSON()` of a browser push subscription (MM-1807). */
export const PushSubscribeRequest = Schema.Struct({
  endpoint: Schema.String.check(Schema.isStartingWith("https://"), Schema.isMaxLength(2048)),
  keys: Schema.Struct({ p256dh: Base64Url, auth: Base64Url }),
});
export type PushSubscribeRequest = typeof PushSubscribeRequest.Type;

/** POST /api/push/unsubscribe and POST /api/push/test: one subscription of this device. */
export const PushEndpointRequest = Schema.Struct({
  endpoint: PushSubscribeRequest.fields.endpoint,
});
export type PushEndpointRequest = typeof PushEndpointRequest.Type;

/** GET /api/push: null when the portal has no `VAPID_JWK` secret. */
export interface PushKeyResponse {
  readonly publicKey: string | null;
}

/** The encrypted body of one push message. The service worker shows it (MM-1808). */
export interface PushMessage {
  readonly title: string;
  readonly body: string;
  /** A portal path with its hash route, for example `/#/inbox`. */
  readonly url: string;
  /** A newer message with the same tag replaces the older one on the device. */
  readonly tag: string;
  /** MM-1805: the count for the app icon. */
  readonly badge: number;
}
