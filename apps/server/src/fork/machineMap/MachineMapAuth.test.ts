/**
 * Fork: machine map. The upstream auth hooks: Cloudflare Access pairing for machine tokens
 * (`EnvironmentAuth.issueCloudflareAccessPairingCredential`, MM-1305) and machine sessions at
 * `/mcp` (`McpOAuth.layerMcpClientAuthenticator`, MM-1307).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthStandardClientScopes,
  EnvironmentId,
  MACHINE_LEVEL_SCOPES,
  type MachineDesiredState,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../../auth/McpOAuth.ts";
import { requiredScopeForRpcMethod } from "../../auth/RpcAuthorization.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
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

const layerState = (enabled: boolean) =>
  MachineMapState.layer.pipe(
    Layer.provide(ServerSettings.layerTest({ machineMap: { enabled } })),
    Layer.provide(ServerSecretStore.layer),
  );

const layerAuthWithoutState = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provideMerge(layerConfig),
);

const layerAuth = (state: "on" | "off") =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(layerState(state === "on")),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provideMerge(layerConfig),
  );

const accessRequest = (jwt: string) =>
  HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1/api/auth/cloudflare-access/pairing-credential", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": jwt },
    }),
  );
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
const pairAs = (claims: Record<string, unknown>) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const issued = yield* auth.issueCloudflareAccessPairingCredential(
      accessRequest(yield* signAccessJwt(claims)),
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
