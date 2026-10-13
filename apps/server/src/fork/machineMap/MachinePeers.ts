/**
 * Fork: machine map. This server as a client of other machines. It pairs with a peer through the
 * tunnel hostname of the peer, with this machine's token as request headers, the same way the
 * desktop app does (MM-306). The peer gives the session the scopes of the arrow (MM-1305).
 */
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthPairingCredentialResult,
  AuthTokenExchangeGrantType,
  type MachineId,
  type PeerMachine,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { callAcpMcpTool } from "../../mcp/AcpMcpStdioBridge.ts";
import { effectiveLevel } from "./machineAccess.ts";
import * as MachineMapState from "./MachineMapState.ts";

const REQUEST_TIMEOUT = Duration.seconds(15);

export class MachinePeerError extends Schema.TaggedError<MachinePeerError>()("MachinePeerError", {
  reason: Schema.Literals([
    "not-on-map",
    "unknown-machine",
    "no-agent-tools",
    "no-hostname",
    "pairing-refused",
    "unreachable",
    "tool-failed",
  ]),
  /** A message safe to show to the agent or the portal. */
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** MM-307: the result of `testArrow`, for the portal. */
export interface ArrowTestResult {
  readonly to: MachineId;
  readonly reachable: boolean;
  /** The round trip of the pairing request, through Cloudflare Access and the tunnel. */
  readonly roundTripMs: number | null;
  readonly scopes: ReadonlyArray<string>;
  readonly error: string | null;
}

interface PeerSession {
  readonly accessToken: string;
  readonly scopes: ReadonlyArray<string>;
}

export class MachinePeers extends Context.Service<
  MachinePeers,
  {
    /** MM-307: pair with the target of an arrow from this machine and report what it granted. */
    readonly testArrow: (to: MachineId) => Effect.Effect<ArrowTestResult>;
    /** MM-801 `machine_tool_call`: call a T3 tool on a peer whose arrow has agent tools. */
    readonly callTool: (input: {
      readonly machine: string;
      readonly tool: string;
      readonly input: Readonly<Record<string, unknown>>;
    }) => Effect.Effect<unknown, MachinePeerError>;
  }
>()("t3/fork/machineMap/MachinePeers") {}

const peerOrigin = (peer: PeerMachine & { readonly hostname: string }) =>
  `https://${peer.hostname}`;

const make = Effect.gen(function* () {
  const state = yield* MachineMapState.MachineMapState;
  const httpClient = yield* HttpClient.HttpClient;
  // One session per peer, so repeated tool calls do not pile up sessions on the peer. A level
  // change on the peer revokes it (MM-1306); the next call then pairs again.
  const sessions = new Map<MachineId, PeerSession>();

  const resolvePeer = (machine: string) =>
    Effect.gen(function* () {
      const local = yield* state.snapshot;
      const desired = local.enabled ? local.saved.desired : null;
      if (desired === null || local.token === null) {
        return yield* new MachinePeerError({
          reason: "not-on-map",
          detail: "This machine is not on the machine map. Join it first.",
        });
      }
      const wanted = machine.trim().toLowerCase();
      const peer = desired.peers.find(
        (candidate) => candidate.id === machine || candidate.name.toLowerCase() === wanted,
      );
      if (peer === undefined || peer.id === desired.self.id) {
        return yield* new MachinePeerError({
          reason: "unknown-machine",
          detail: `No other machine named "${machine}" is on the map.`,
        });
      }
      if (peer.hostname === null) {
        return yield* new MachinePeerError({
          reason: "no-hostname",
          detail: `${peer.name} has not reported its tunnel hostname yet.`,
        });
      }
      const arrow = desired.arrowsOut.find(
        (candidate) => candidate.from === desired.self.id && candidate.to === peer.id,
      );
      return {
        peer: { ...peer, hostname: peer.hostname },
        arrow,
        token: local.token,
        selfName: desired.self.name,
      };
    });

  const pair = (
    peer: PeerMachine & { readonly hostname: string },
    token: MachineMapState.MachineToken,
    selfName: string,
  ) =>
    Effect.gen(function* () {
      const origin = peerOrigin(peer);
      const headers = MachineMapState.tokenHeaders(token);
      const credential = yield* HttpClientRequest.post(
        `${origin}/api/auth/cloudflare-access/pairing-credential`,
      ).pipe(
        HttpClientRequest.setHeaders(headers),
        httpClient.execute,
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(AuthPairingCredentialResult)),
        Effect.timeout(REQUEST_TIMEOUT),
      );
      const exchanged = yield* HttpClientRequest.post(`${origin}/oauth/token`).pipe(
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.bodyUrlParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: credential.credential,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          client_label: `machine ${selfName}`,
          client_device_type: "bot",
        }),
        httpClient.execute,
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(AuthAccessTokenResult)),
        Effect.timeout(REQUEST_TIMEOUT),
      );
      const session: PeerSession = {
        accessToken: exchanged.access_token,
        scopes: exchanged.scope.split(" ").filter((scope) => scope.length > 0),
      };
      sessions.set(peer.id, session);
      return session;
    });

  const describe = (cause: unknown): string => {
    if (HttpClientError.isHttpClientError(cause)) {
      return cause.response === undefined ? cause.reason._tag : `HTTP ${cause.response.status}`;
    }
    return Predicate.isTagged(cause, "TimeoutError") ? "timed out" : "unexpected response";
  };

  const testArrow: MachinePeers["Service"]["testArrow"] = (to) =>
    Effect.gen(function* () {
      const resolved = yield* resolvePeer(to);
      const startedAt = yield* Clock.currentTimeMillis;
      return yield* pair(resolved.peer, resolved.token, resolved.selfName).pipe(
        Effect.flatMap((session) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((endedAt): ArrowTestResult => ({
              to,
              reachable: true,
              roundTripMs: endedAt - startedAt,
              scopes: session.scopes,
              error: null,
            })),
          ),
        ),
        Effect.catch((cause) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((endedAt): ArrowTestResult => {
              const detail = describe(cause);
              // Access answers 403 and the peer answers 401 when the arrow grants nothing.
              const refused = detail === "HTTP 401" || detail === "HTTP 403";
              return {
                to,
                reachable: refused,
                roundTripMs: refused ? endedAt - startedAt : null,
                scopes: [],
                error: refused ? `${detail}: the arrow grants no access` : detail,
              };
            }),
          ),
        ),
      );
    }).pipe(
      Effect.catchTags({
        MachinePeerError: (error) =>
          Effect.succeed({
            to,
            reachable: false,
            roundTripMs: null,
            scopes: [],
            error: error.detail,
          } satisfies ArrowTestResult),
      }),
    );

  const callTool: MachinePeers["Service"]["callTool"] = (input) =>
    Effect.gen(function* () {
      const resolved = yield* resolvePeer(input.machine);
      const nowMs = yield* Clock.currentTimeMillis;
      if (
        resolved.arrow === undefined ||
        !resolved.arrow.agentTools ||
        effectiveLevel(resolved.arrow, nowMs) === "none"
      ) {
        return yield* new MachinePeerError({
          reason: "no-agent-tools",
          detail: `The arrow from this machine to ${resolved.peer.name} does not allow agent tools.`,
        });
      }
      const headers = MachineMapState.tokenHeaders(resolved.token);
      const call = (session: PeerSession) =>
        callAcpMcpTool({
          endpoint: `${peerOrigin(resolved.peer)}/mcp`,
          authorization: `Bearer ${session.accessToken}`,
          tool: input.tool,
          arguments: input.input,
          // Cloudflare Access in front of the peer needs the machine token on every request.
          fetchImplementation: (url, init) =>
            // @effect-diagnostics-next-line globalFetch:off - the MCP bridge takes a fetch function; this only adds the Access headers.
            fetch(url, { ...init, headers: { ...(init?.headers as object), ...headers } }),
        });
      const pairOrFail = pair(resolved.peer, resolved.token, resolved.selfName).pipe(
        Effect.mapError(
          (cause) =>
            new MachinePeerError({
              reason: "pairing-refused",
              detail: `${resolved.peer.name} refused the pairing: ${describe(cause)}.`,
            }),
        ),
      );
      const cached = sessions.get(resolved.peer.id);
      const first = cached ?? (yield* pairOrFail);
      return yield* call(first).pipe(
        // The bridge reports a revoked session only in its message. Pair again once.
        Effect.catch((error) =>
          cached !== undefined && error.message.includes("HTTP 401")
            ? Effect.sync(() => sessions.delete(resolved.peer.id)).pipe(
                Effect.andThen(pairOrFail),
                Effect.flatMap(call),
              )
            : Effect.fail(error),
        ),
        Effect.mapError((error) =>
          error._tag === "MachinePeerError"
            ? error
            : new MachinePeerError({
                reason: "tool-failed",
                detail: `${input.tool} on ${resolved.peer.name} failed: ${error.message.slice(0, 500)}`,
              }),
        ),
      );
    });

  return MachinePeers.of({ testArrow, callTool });
});

export const layer = Layer.effect(MachinePeers, make);
