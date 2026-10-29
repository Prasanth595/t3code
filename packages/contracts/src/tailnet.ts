import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Every grant and session a device gets through Tailscale sign-in has this subject prefix. */
export const TAILNET_SUBJECT_PREFIX = "tailscale:";

/** The auth subject of the Tailscale node with this StableID. */
export const tailnetSubject = (stableNodeId: string): string =>
  `${TAILNET_SUBJECT_PREFIX}${stableNodeId}`;

/** A two-minute grant bound to the request's DPoP key. Exchange it at `/oauth/token`. */
export const AuthTailnetSignInResult = Schema.Struct({
  credential: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthTailnetSignInResult = typeof AuthTailnetSignInResult.Type;

/** Why this host refused Tailscale sign-in. Each reason is a check from the security model. */
export const TailnetSignInRefusedReason = Schema.Literals([
  "disabled",
  "browser_request",
  "not_direct_tailnet",
  "tailscale_unavailable",
  "tailscale_outdated",
  "owner_unknown",
  "tagged_device",
  "shared_device",
  "other_user",
  "own_node",
  "routes_for_others",
  "blocked",
  "rate_limited",
]);
export type TailnetSignInRefusedReason = typeof TailnetSignInRefusedReason.Type;

/** A device that signed in through Tailscale, or one this host blocks. */
export const TailnetDevice = Schema.Struct({
  stableNodeId: TrimmedNonEmptyString,
  label: Schema.NullOr(TrimmedNonEmptyString),
  blockedAt: Schema.NullOr(Schema.DateTimeUtc),
  activeSessionCount: NonNegativeInt,
  /** The device asking, so blocking it cuts the asker off. */
  current: Schema.Boolean,
});
export type TailnetDevice = typeof TailnetDevice.Type;

export const TailnetDeviceInput = Schema.Struct({
  stableNodeId: TrimmedNonEmptyString,
});
export type TailnetDeviceInput = typeof TailnetDeviceInput.Type;

export const TailnetDeviceList = Schema.Struct({
  devices: Schema.Array(TailnetDevice),
});
export type TailnetDeviceList = typeof TailnetDeviceList.Type;

/** A dotted IPv4 address in 100.64.0.0/10, where Tailscale assigns node addresses. */
export const TailnetIpv4 = Schema.String.check(
  Schema.isPattern(
    /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){2}$/u,
  ),
);

/** Another T3 Code environment on this host's tailnet. Holds no route or credential. */
export const TailnetPeerEnvironment = Schema.Struct({
  name: TrimmedNonEmptyString,
  magicDnsName: Schema.NullOr(TrimmedNonEmptyString),
  tailnetIpv4: TailnetIpv4,
  environmentId: EnvironmentId,
});
export type TailnetPeerEnvironment = typeof TailnetPeerEnvironment.Type;

export const TailnetPeerList = Schema.Struct({
  peers: Schema.Array(TailnetPeerEnvironment),
});
export type TailnetPeerList = typeof TailnetPeerList.Type;

export class TailnetAccessError extends Schema.TaggedError<TailnetAccessError>()(
  "TailnetAccessError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

/** A machine's own Tailscale. `unreadable` means `tailscale status` failed in another way. */
export const TailscaleState = Schema.Literals([
  "running",
  "not_installed",
  "not_running",
  "needs_login",
  "needs_machine_approval",
  "stopped",
  "starting",
  "unreadable",
]);
export type TailscaleState = typeof TailscaleState.Type;

/** Maps tailscaled's `BackendState`. `NoState` is a daemon that has only just started. */
export function tailscaleStateFromBackend(backendState: string | null): TailscaleState {
  switch (backendState) {
    case "Running":
      return "running";
    case "NeedsLogin":
      return "needs_login";
    case "NeedsMachineAuth":
      return "needs_machine_approval";
    case "Stopped":
      return "stopped";
    case "Starting":
    case "NoState":
      return "starting";
    default:
      return "unreadable";
  }
}
