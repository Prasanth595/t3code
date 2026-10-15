/**
 * Fork: machine map. The upstream auth hooks: Cloudflare Access pairing for machine tokens
 * (`EnvironmentAuth.issueCloudflareAccessPairingCredential`, MM-1305) and machine sessions at
 * `/mcp` (`McpOAuth.layerMcpClientAuthenticator`, MM-1307), and the pause lock (MM-718).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthStandardClientScopes,
  type ClientAccessMode,
  ClientId,
  EnvironmentId,
  MACHINE_LEVEL_SCOPES,
  type MachineDesiredState,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpServerRequest } from "effect/http";
import { computeDpopJwkThumbprint, type DpopPublicJwk } from "@t3tools/shared/dpop";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../../auth/McpOAuth.ts";
import { requiredScopeForRpcMethod } from "../../auth/RpcAuthorization.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { isLocalDesktopSubject } from "./machineAccess.ts";
import { PEER, PEER_TOKEN, SELF, arrow, desiredState } from "./MachineMap.testkit.ts";
import * as MachineMapState from "./MachineMapState.ts";

const ACCESS_TEAM = "team.cloudflareaccess.com";
const CERTS_URL = `https://${ACCESS_TEAM}/cdn-cgi/access/certs`;
const accessKeys = await generateKeyPair("RS256");
const accessJwk = { ...(await exportJWK(accessKeys.publicKey)), kid: "key-1", alg: "RS256" };
const signAccessJwt = (claims: Record<string, unknown>) =>
  Effect.promise(() =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setIssuer(`https://${ACCESS_TEAM}`)
      .setAudience("aud-tag")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(accessKeys.privateKey),
  );

// The Access keys come from the team certs URL, so the test serves them from a fetch stub.
const withCertsFetch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) =>
        (input instanceof Request ? input.url : String(input)) === CERTS_URL
          ? Response.json({ keys: [accessJwk] })
          : new Response(null, { status: 404 })) as typeof fetch;
      return realFetch;
    }),
    () => effect,
    (realFetch) => Effect.sync(() => (globalThis.fetch = realFetch)),
  );

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      cloudflareAccess: { teamDomain: ACCESS_TEAM, aud: "aud-tag", subjects: ["dev@example.com"] },
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-machine-map-auth-" })));

const layerState = (enabled: boolean, clientAccess: ClientAccessMode = "off") =>
  MachineMapState.layer.pipe(
    Layer.provide(ServerSettings.layerTest({ machineMap: { enabled }, clientAccess })),
    Layer.provide(ServerSecretStore.layer),
  );

const layerAuthWithoutState = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provideMerge(layerConfig),
);

const layerAuth = (state: "on" | "off", clientAccess: ClientAccessMode = "off") =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(layerState(state === "on", clientAccess)),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provideMerge(layerConfig),
  );

const PAIRING_URL = "http://127.0.0.1/api/auth/cloudflare-access/pairing-credential";
const accessRequest = (jwt: string, dpop?: string) =>
  HttpServerRequest.fromWeb(
    new Request(PAIRING_URL, {
      method: "POST",
      headers: {
        host: "127.0.0.1",
        "cf-access-jwt-assertion": jwt,
        ...(dpop === undefined ? {} : { dpop }),
      },
    }),
  );

// A browser key, as `apps/web/src/cloud/dpop.ts` makes it.
const browserKeys = await generateKeyPair("ES256");
const browserJwk = (await exportJWK(browserKeys.publicKey)) as DpopPublicJwk;
let proofCount = 0;
// The proof time comes from the test clock, which the server checks it against.
const browserProof = () =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((nowMs) =>
      Effect.promise(() =>
        new SignJWT({ htm: "POST", htu: PAIRING_URL, jti: `proof-${++proofCount}` })
          .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: browserJwk })
          .setIssuedAt(Math.floor(nowMs / 1000))
          .sign(browserKeys.privateKey),
      ),
    ),
  );
const LAPTOP = ClientId.make("client-laptop");
const withLaptopAdmin = {
  ...desiredState({}),
  browserClients: [
    {
      id: LAPTOP,
      name: "Laptop",
      thumbprints: [computeDpopJwkThumbprint(browserJwk)],
      level: "admin" as const,
      expiresAt: null,
      revertLevel: null,
    },
  ],
};
const bearerRequest = (token: string) =>
  HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1/mcp", { headers: { authorization: `Bearer ${token}` } }),
  );

const saveDesired = (desired: MachineDesiredState) =>
  Effect.gen(function* () {
    const state = yield* MachineMapState.MachineMapState;
    yield* state.updateSaved((saved) => ({ ...saved, desired }));
  });

/** Pairs through Cloudflare Access like a peer, then exchanges the credential for a session. */
const pairAs = (claims: Record<string, unknown>, dpop?: string) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const issued = yield* auth.issueCloudflareAccessPairingCredential(
      accessRequest(yield* signAccessJwt(claims), dpop),
    );
    if (issued === undefined) return undefined;
    const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
      issued.credential,
      undefined,
      { deviceType: "bot" },
    );
    return yield* auth.authenticateHttpRequest(bearerRequest(token.access_token));
  });

it("the machine map RPCs need the scope of what they change, and the token is desktop-only", () => {
  expect(requiredScopeForRpcMethod(WS_METHODS.machineMapSubscribe)).toBe(
    AuthOrchestrationReadScope,
  );
  // Joining and leaving turn the machineMap setting on and off.
  expect(requiredScopeForRpcMethod(WS_METHODS.machineMapJoin)).toBe(AuthSettingsWriteScope);
  expect(requiredScopeForRpcMethod(WS_METHODS.machineMapLeave)).toBe(AuthSettingsWriteScope);
  expect(requiredScopeForRpcMethod(WS_METHODS.machineMapReportDesktop)).toBe(
    AuthEnvironmentMaintainScope,
  );
  expect(isLocalDesktopSubject("desktop-bootstrap")).toBe(true);
  expect(isLocalDesktopSubject("one-time-token")).toBe(false);
  expect(isLocalDesktopSubject(`machine:${PEER}`)).toBe(false);
});

it.layer(NodeServices.layer)("machine map auth hooks", (it) => {
  it.effect("a machine token pairs with the scopes and subject of its arrow (MM-1305)", () =>
    Effect.gen(function* () {
      yield* saveDesired(desiredState({ arrowsIn: [arrow(PEER, SELF, "standard")] }));
      const session = yield* pairAs({ common_name: PEER_TOKEN });
      expect(session?.subject).toBe(`machine:${PEER}`);
      expect(session?.scopes).toEqual(AuthStandardClientScopes);
    }).pipe(withCertsFetch, Effect.provide(layerAuth("on"))),
  );

  it.effect("level none and an unknown token get nothing; the owner keeps its login", () =>
    Effect.gen(function* () {
      yield* saveDesired(desiredState({ arrowsIn: [arrow(PEER, SELF, "none")] }));
      expect(yield* pairAs({ common_name: PEER_TOKEN })).toBeUndefined();
      expect(yield* pairAs({ common_name: "unknown.access" })).toBeUndefined();
      // MM-308: no arrow removes the owner login.
      const owner = yield* pairAs({ email: "dev@example.com" });
      expect(owner?.subject).toBe("one-time-token");
      expect(owner?.scopes).toEqual(AuthStandardClientScopes);
    }).pipe(withCertsFetch, Effect.provide(layerAuth("on"))),
  );

  it.effect("with the machineMap setting off, a machine token gets nothing (MM-1301)", () =>
    Effect.gen(function* () {
      yield* saveDesired(desiredState({ arrowsIn: [arrow(PEER, SELF, "admin")] }));
      expect(yield* pairAs({ common_name: PEER_TOKEN })).toBeUndefined();
    }).pipe(withCertsFetch, Effect.provide(layerAuth("off"))),
  );

  it.effect("without the machine map service, a machine token gets nothing", () =>
    Effect.gen(function* () {
      expect(yield* pairAs({ common_name: PEER_TOKEN })).toBeUndefined();
      expect((yield* pairAs({ email: "dev@example.com" }))?.subject).toBe("one-time-token");
    }).pipe(withCertsFetch, Effect.provide(layerAuthWithoutState)),
  );

  it.effect(
    "an approved browser key gets its client, at most standard, under observe (MM-917)",
    () =>
      Effect.gen(function* () {
        yield* saveDesired(withLaptopAdmin);
        const session = yield* pairAs({ email: "dev@example.com" }, yield* browserProof());
        expect(session?.subject).toBe(`client:${LAPTOP}`);
        expect(session?.scopes).toEqual(AuthStandardClientScopes);
      }).pipe(withCertsFetch, Effect.provide(layerAuth("on", "observe"))),
  );

  it.effect("with clientAccess off, an approved browser key keeps the owner login (MM-916)", () =>
    Effect.gen(function* () {
      yield* saveDesired(withLaptopAdmin);
      const session = yield* pairAs({ email: "dev@example.com" }, yield* browserProof());
      expect(session?.subject).toBe("one-time-token");
      expect(session?.scopes).toEqual(AuthStandardClientScopes);
    }).pipe(withCertsFetch, Effect.provide(layerAuth("on", "off"))),
  );

  it.effect("/mcp admits a machine session only while its arrow has agent tools (MM-1307)", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const clients = yield* McpHttpServer.McpClientAuthenticator;
      const machine = yield* auth.issueSession({
        subject: `machine:${PEER}`,
        scopes: MACHINE_LEVEL_SCOPES.standard,
      });
      yield* saveDesired(desiredState({ arrowsIn: [arrow(PEER, SELF, "standard")] }));
      expect(yield* clients.authenticate(bearerRequest(machine.token))).toBeUndefined();

      yield* saveDesired(
        desiredState({ arrowsIn: [arrow(PEER, SELF, "standard", { agentTools: true })] }),
      );
      const admitted = yield* clients.authenticate(bearerRequest(machine.token));
      expect(admitted?.client?.access).toBe("full-access");
      expect(admitted?.requestNamespace.startsWith("machine-session:")).toBe(true);

      yield* saveDesired(
        desiredState({ arrowsIn: [arrow(PEER, SELF, "read", { agentTools: true })] }),
      );
      expect((yield* clients.authenticate(bearerRequest(machine.token)))?.client?.access).toBe(
        "read-only",
      );

      // An OAuth MCP client keeps its own path.
      const oauthClient = yield* auth.issueMcpClientSession({
        label: "client",
        access: "read-only",
        client: { deviceType: "bot" },
      });
      const client = yield* clients.authenticate(bearerRequest(oauthClient.token));
      expect(client?.requestNamespace).toBe(`client:${oauthClient.sessionId}`);
    }).pipe(
      Effect.provide(
        McpOAuth.layerMcpClientAuthenticator.pipe(
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:machine-map")),
            }),
          ),
          Layer.provideMerge(layerAuth("on")),
        ),
      ),
    ),
  );
});

const pausedReason = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.exit,
    Effect.map(
      (exit) =>
        Exit.isFailure(exit) &&
        exit.cause.reasons.some(
          (reason) =>
            reason._tag === "Fail" &&
            EnvironmentAuth.isServerAuthCredentialError(reason.error) &&
            EnvironmentAuth.serverAuthCredentialReason(reason.error) === "machine_paused",
        ),
    ),
  );

/** One session of each kind that the pause must tell apart. */
const sessionsOfEachKind = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessions = yield* SessionStore.SessionStore;
  const desktop = yield* auth.issueSession({ subject: "desktop-bootstrap" });
  const mobile = yield* auth.issueSession({ subject: "one-time-token" });
  const pairing = yield* auth.issuePairingCredential();
  const browser = yield* auth.createBrowserSession(pairing.credential, { deviceType: "desktop" });
  const cookieRequest = HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1/api/auth/session", {
      headers: { cookie: `${sessions.cookieName}=${browser.sessionToken}` },
    }),
  );
  const mcp = yield* auth.issueMcpClientSession({
    label: "agent",
    access: "full-access",
    client: { deviceType: "bot" },
  });
  return { auth, desktop, mobile, cookieRequest, mcp };
});

it.layer(NodeServices.layer)("machine map pause lock (MM-718)", (it) => {
  it.effect("while paused, only the desktop app and MCP clients authenticate", () =>
    Effect.gen(function* () {
      const { auth, desktop, mobile, cookieRequest, mcp } = yield* sessionsOfEachKind;
      yield* saveDesired(desiredState({ paused: true }));

      expect((yield* auth.authenticateHttpRequest(bearerRequest(desktop.token))).subject).toBe(
        "desktop-bootstrap",
      );
      expect(yield* pausedReason(auth.authenticateHttpRequest(bearerRequest(mobile.token)))).toBe(
        true,
      );
      expect(yield* pausedReason(auth.authenticateWebSocketUpgrade(cookieRequest))).toBe(true);
      expect(yield* auth.getSessionState(cookieRequest)).toMatchObject({
        authenticated: false,
        machinePaused: true,
      });
      // A ticket minted before the pause does not open a socket during it.
      const ticket = yield* auth.issueWebSocketTicket({ sessionId: mobile.sessionId });
      const ticketRequest = HttpServerRequest.fromWeb(
        new Request(`http://127.0.0.1/ws?wsTicket=${ticket.ticket}`),
      );
      expect(yield* pausedReason(auth.authenticateWebSocketUpgrade(ticketRequest))).toBe(true);
      // MM-711 governs agents; the pause does not lock the MCP endpoint.
      expect((yield* auth.authenticateMcpClient(bearerRequest(mcp.token))).sessionId).toBe(
        mcp.sessionId,
      );
    }).pipe(Effect.provide(layerAuth("on"))),
  );

  it.effect("while paused, a valid Cloudflare Access login gets no new session", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      yield* saveDesired(desiredState({ paused: true }));
      const login = accessRequest(yield* signAccessJwt({ email: "dev@example.com" }));
      expect(yield* pausedReason(auth.issueCloudflareAccessPairingCredential(login))).toBe(true);
    }).pipe(withCertsFetch, Effect.provide(layerAuth("on"))),
  );

  it.effect("paused false or an absent flag unlocks at once, and open sockets close on pause", () =>
    Effect.gen(function* () {
      const { auth, mobile, cookieRequest } = yield* sessionsOfEachKind;
      const state = yield* MachineMapState.MachineMapState;
      yield* saveDesired(desiredState({ paused: true }));
      // The socket of a locked session ends at once.
      yield* state.awaitLockFor("one-time-token");
      expect(yield* state.lockedFor("desktop-bootstrap")).toBe(false);

      yield* saveDesired(desiredState({ paused: false }));
      expect((yield* auth.authenticateHttpRequest(bearerRequest(mobile.token))).subject).toBe(
        "one-time-token",
      );
      yield* saveDesired(desiredState({ paused: true }));
      yield* saveDesired(desiredState({}));
      expect((yield* auth.getSessionState(cookieRequest)).authenticated).toBe(true);
    }).pipe(Effect.provide(layerAuth("on"))),
  );

  it.effect("with the machineMap setting off, a saved pause does not lock (MM-1301)", () =>
    Effect.gen(function* () {
      const { auth, mobile } = yield* sessionsOfEachKind;
      yield* saveDesired(desiredState({ paused: true }));
      expect((yield* auth.authenticateHttpRequest(bearerRequest(mobile.token))).subject).toBe(
        "one-time-token",
      );
    }).pipe(Effect.provide(layerAuth("off"))),
  );

  it.effect("an unreadable state file locks until the portal sends a desired state", () =>
    Effect.gen(function* () {
      const { auth, mobile } = yield* sessionsOfEachKind;
      expect(yield* pausedReason(auth.authenticateHttpRequest(bearerRequest(mobile.token)))).toBe(
        true,
      );
      yield* saveDesired(desiredState({}));
      expect((yield* auth.authenticateHttpRequest(bearerRequest(mobile.token))).subject).toBe(
        "one-time-token",
      );
    }).pipe(
      Effect.provide(
        EnvironmentAuth.layer.pipe(
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provideMerge(
            layerState(true).pipe(
              Layer.provide(
                Layer.effectDiscard(
                  Effect.gen(function* () {
                    const config = yield* ServerConfig.ServerConfig;
                    const fileSystem = yield* FileSystem.FileSystem;
                    const path = yield* Path.Path;
                    yield* fileSystem.makeDirectory(config.stateDir, { recursive: true });
                    yield* fileSystem.writeFileString(
                      path.join(config.stateDir, "machine-map.json"),
                      "{ not json",
                    );
                  }),
                ),
              ),
            ),
          ),
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(ServerEnvironment.layerIdentity),
          Layer.provideMerge(layerConfig),
        ),
      ),
    ),
  );
});
