import {
  type AuthTailnetSignInResult,
  AuthStandardClientScopes,
  TAILNET_SUBJECT_PREFIX,
  TailnetAccessError,
  type TailnetDevice,
  TailnetSignInRefusedReason,
  tailnetSubject,
} from "@t3tools/contracts";
import {
  isTailscaleIpv4Address,
  type TailscaleStatus,
  type TailscaleWhois,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { DESKTOP_RENDERER_ORIGINS } from "../httpCors.ts";
import * as AuthTailnetDeviceBlocks from "../persistence/AuthTailnetDeviceBlocks.ts";
import * as TailscaleHost from "../tailscale/TailscaleHost.ts";
import { verifyRequestDpopProof } from "./dpop.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const GRANT_TTL = Duration.minutes(2);

export class TailnetSignInRefusedError extends Schema.TaggedError<TailnetSignInRefusedError>()(
  "TailnetSignInRefusedError",
  {
    reason: TailnetSignInRefusedReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Tailscale sign-in refused (${this.reason}).`;
  }
}

export class TailnetDeviceBlockLookupError extends Schema.TaggedError<TailnetDeviceBlockLookupError>()(
  "TailnetDeviceBlockLookupError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to check whether the device is blocked.";
  }
}

export class TailnetSignIn extends Context.Service<
  TailnetSignIn,
  {
    /**
     * Mints a two-minute grant bound to the request's DPoP key for the owner's
     * own untagged device. Renewal calls this again, so every check reruns.
     */
    readonly signIn: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<
      AuthTailnetSignInResult,
      | TailnetSignInRefusedError
      | TailnetDeviceBlockLookupError
      | EnvironmentAuth.ServerAuthInvalidCredentialError
      | EnvironmentAuth.ServerAuthInternalError
    >;
    /** `currentSubject` is the asking session's, which marks that device `current`. */
    readonly listDevices: (
      currentSubject: string,
    ) => Effect.Effect<ReadonlyArray<TailnetDevice>, TailnetAccessError>;
    /** Refuses the device here and ends its sessions. Returns how many sessions ended. */
    readonly blockDevice: (stableNodeId: string) => Effect.Effect<number, TailnetAccessError>;
    readonly unblockDevice: (stableNodeId: string) => Effect.Effect<boolean, TailnetAccessError>;
  }
>()("t3/auth/TailnetSignIn") {}

interface RequestSocket {
  readonly localAddress?: string | undefined;
  readonly remoteAddress?: string | undefined;
  readonly localPort?: number | undefined;
}

// The socket, never X-Forwarded-For: Serve and Funnel arrive from loopback and must stay refused.
const requestSocket = (request: HttpServerRequest.HttpServerRequest): RequestSocket => {
  const source = request.source as { readonly socket?: RequestSocket } | undefined;
  return source?.socket ?? {};
};

const plainIpv4 = (address: string | undefined) => address?.replace(/^::ffff:/i, "");

const isTrustedOrigin = (origin: string | undefined) =>
  origin === undefined || (DESKTOP_RENDERER_ORIGINS as ReadonlyArray<string>).includes(origin);

/**
 * DNS rebinding sends this host's address under another name. Accept only the
 * names and addresses Tailscale gives this host, on the port the socket serves.
 */
const isOwnHost = (host: string | undefined, status: TailscaleStatus, localPort: number) => {
  if (host === undefined) return false;
  const names = [
    ...status.tailnetIpv4Addresses,
    ...(status.magicDnsName === null
      ? []
      : [status.magicDnsName, status.magicDnsName.split(".")[0]!]),
  ].map((name) => name.toLowerCase());
  const accepted = new Set(
    names.flatMap((name) => (localPort === 80 ? [name, `${name}:80`] : [`${name}:${localPort}`])),
  );
  return accepted.has(host.toLowerCase());
};

// An exit node forwards its peers' traffic to the internet, never other devices
// into the tailnet, so it still speaks only for itself. A subnet router does not.
const EXIT_NODE_ROUTES = ["0.0.0.0/0", "::/0"];

/** The first check this node fails, or null when it is the owner's own device. */
const refuseNode = (
  node: TailscaleWhois,
  status: TailscaleStatus,
  ownerUserId: string,
): TailnetSignInRefusedReason | null => {
  if (node.tags.length > 0) return "tagged_device";
  if (node.sharerUserId !== null) return "shared_device";
  if (node.stableNodeId === status.selfNodeId) return "own_node";
  if (node.userId !== ownerUserId) return "other_user";
  const accepted = new Set([...node.addresses, ...EXIT_NODE_ROUTES]);
  if (node.primaryRoutes.length > 0 || node.allowedIps.some((ip) => !accepted.has(ip))) {
    return "routes_for_others";
  }
  return null;
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const host = yield* TailscaleHost.TailscaleHost;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessions = yield* SessionStore.SessionStore;
  const blocks = yield* AuthTailnetDeviceBlocks.AuthTailnetDeviceBlockRepository;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;

  const refuse = (reason: TailnetSignInRefusedReason, cause?: unknown) =>
    // Every server that is not set up for sign-in, and every browser, sees these routinely.
    (reason === "disabled" || reason === "browser_request" ? Effect.logDebug : Effect.logWarning)(
      "Refused Tailscale sign-in.",
    ).pipe(
      Effect.annotateLogs({ reason }),
      Effect.andThen(
        Effect.fail(
          new TailnetSignInRefusedError({ reason, ...(cause === undefined ? {} : { cause }) }),
        ),
      ),
    );

  const signIn: TailnetSignIn["Service"]["signIn"] = Effect.fn("TailnetSignIn.signIn")(
    function* (request) {
      if (config.tailscaleSignInEnabled !== true) return yield* refuse("disabled");
      // A hard 403: production CORS allows any origin and the `dpop` header.
      if (!isTrustedOrigin(request.headers.origin)) return yield* refuse("browser_request");

      const status = yield* host.status.pipe(
        Effect.catch((cause) => refuse("tailscale_unavailable", cause)),
      );
      if (status.backendState !== "Running" || status.userspaceNetworking === true) {
        return yield* refuse("tailscale_unavailable");
      }
      if (!TailscaleHost.isSupportedTailscaleVersion(status.version)) {
        return yield* refuse("tailscale_outdated");
      }

      const socket = requestSocket(request);
      if (
        socket.localPort === undefined ||
        !isOwnHost(request.headers.host, status, socket.localPort)
      ) {
        return yield* refuse("browser_request");
      }
      const remoteAddress = plainIpv4(socket.remoteAddress);
      const localAddress = plainIpv4(socket.localAddress);
      if (
        remoteAddress === undefined ||
        localAddress === undefined ||
        !isTailscaleIpv4Address(remoteAddress) ||
        !status.tailnetIpv4Addresses.includes(localAddress)
      ) {
        return yield* refuse("not_direct_tailnet");
      }

      const ownerUserId = TailscaleHost.tailnetOwnerUserId(status, config.tailscaleOwnerUserId);
      if (ownerUserId === null) return yield* refuse("owner_unknown");

      const proofKeyThumbprint = yield* verifyRequestDpopProof({ request }).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
        Effect.provideService(Crypto.Crypto, crypto),
      );

      // A missing required field fails the parse, so it refuses like an unreachable daemon.
      const node = yield* host
        .whois(remoteAddress)
        .pipe(
          Effect.catch((cause) =>
            refuse(
              cause._tag === "TailscaleWhoisRateLimitedError"
                ? "rate_limited"
                : "tailscale_unavailable",
              cause,
            ),
          ),
        );
      const refusal = refuseNode(node, status, ownerUserId);
      if (refusal !== null) return yield* refuse(refusal);

      const blocked = yield* blocks
        .isBlocked({ stableNodeId: node.stableNodeId })
        .pipe(Effect.mapError((cause) => new TailnetDeviceBlockLookupError({ cause })));
      if (blocked) return yield* refuse("blocked");

      const issued = yield* environmentAuth.createPairingLink({
        subject: tailnetSubject(node.stableNodeId),
        proofKeyThumbprint,
        ttl: GRANT_TTL,
        scopes: AuthStandardClientScopes,
        ...(node.computedName === null ? {} : { label: node.computedName }),
      });
      return { credential: issued.credential, expiresAt: issued.expiresAt };
    },
  );

  const accessError = (message: string) => (cause: unknown) =>
    new TailnetAccessError({ message, cause });

  const listDevices: TailnetSignIn["Service"]["listDevices"] = Effect.fn(
    "TailnetSignIn.listDevices",
  )(function* (currentSubject) {
    const [active, blocked] = yield* Effect.all(
      [
        sessions.listActive().pipe(Effect.mapError(accessError("Could not list sessions."))),
        blocks.list().pipe(Effect.mapError(accessError("Could not list blocked devices."))),
      ],
      { concurrency: "unbounded" },
    );
    const devices = new Map<string, TailnetDevice>();
    for (const session of active) {
      if (!session.subject.startsWith(TAILNET_SUBJECT_PREFIX)) continue;
      const stableNodeId = session.subject.slice(TAILNET_SUBJECT_PREFIX.length);
      const existing = devices.get(stableNodeId);
      devices.set(stableNodeId, {
        stableNodeId,
        label: existing?.label ?? session.client.label ?? null,
        blockedAt: null,
        activeSessionCount: (existing?.activeSessionCount ?? 0) + 1,
        current: session.subject === currentSubject,
      });
    }
    for (const block of blocked) {
      const existing = devices.get(block.stableNodeId);
      devices.set(block.stableNodeId, {
        stableNodeId: block.stableNodeId,
        label: existing?.label ?? block.label,
        blockedAt: block.blockedAt,
        activeSessionCount: existing?.activeSessionCount ?? 0,
        current: `${TAILNET_SUBJECT_PREFIX}${block.stableNodeId}` === currentSubject,
      });
    }
    return [...devices.values()];
  });

  const blockDevice: TailnetSignIn["Service"]["blockDevice"] = Effect.fn(
    "TailnetSignIn.blockDevice",
  )(function* (stableNodeId) {
    const subject = tailnetSubject(stableNodeId);
    const label =
      (yield* sessions
        .listActive()
        .pipe(Effect.mapError(accessError("Could not list sessions.")))).find(
        (session) => session.subject === subject,
      )?.client.label ?? null;
    const blockedAt = yield* DateTime.now;
    // Shares the writer with the grant exchange, so no session for this device survives.
    return yield* blocks
      .block({ stableNodeId, label, blockedAt })
      .pipe(
        Effect.andThen(sessions.revokeBySubject(subject)),
        sql.withTransaction,
        Effect.mapError(accessError("Could not block the device.")),
      );
  });

  const unblockDevice: TailnetSignIn["Service"]["unblockDevice"] = Effect.fn(
    "TailnetSignIn.unblockDevice",
  )(function* (stableNodeId) {
    return yield* blocks
      .unblock({ stableNodeId })
      .pipe(Effect.mapError(accessError("Could not unblock the device.")));
  });

  return TailnetSignIn.of({ signIn, listDevices, blockDevice, unblockDevice });
});

export const layer = Layer.effect(TailnetSignIn, make).pipe(
  Layer.provideMerge(AuthTailnetDeviceBlocks.layer),
);
