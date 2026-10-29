// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync or sign.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { computeDpopJwkThumbprint, type DpopPublicJwk } from "@t3tools/shared/dpop";
import { parseTailscaleStatus, parseTailscaleWhois } from "@t3tools/tailscale";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TailscaleHost from "../tailscale/TailscaleHost.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as TailnetSignIn from "./TailnetSignIn.ts";

// 2^53 + 1 and 2^53: equal as JS numbers, different Tailscale users.
const OWNER_ID = "9007199254740993";
const NEIGHBOR_ID = "9007199254740992";
const HOST_ADDRESS = "100.100.1.1";
const PHONE_ADDRESS = "100.88.1.2";

type JsonObject = Record<string, unknown>;

// Writes user IDs as bare int64 digits, the way Tailscale does.
const tailscaleJson = (value: JsonObject) => JSON.stringify(value).replace(/"int64:(\d+)"/gu, "$1");

const hostStatus = (overrides: JsonObject = {}) => ({
  Version: "1.102.2-t6cac91817",
  BackendState: "Running",
  TUN: true,
  Self: {
    ID: "nBox",
    UserID: `int64:${OWNER_ID}`,
    DNSName: "box.tail.ts.net.",
    TailscaleIPs: [HOST_ADDRESS],
  },
  ...overrides,
});

const phoneNode = (overrides: JsonObject = {}): JsonObject => ({
  StableID: "nPhone",
  User: `int64:${OWNER_ID}`,
  Addresses: [`${PHONE_ADDRESS}/32`],
  AllowedIPs: [`${PHONE_ADDRESS}/32`],
  ComputedName: "phone",
  ...overrides,
});

/** What `tailscale status` and `tailscale whois` print; a test may change it between calls. */
interface Tailnet {
  status: JsonObject;
  node: JsonObject | null;
}

const layerTailscaleHost = (tailnet: Tailnet) =>
  Layer.succeed(
    TailscaleHost.TailscaleHost,
    TailscaleHost.TailscaleHost.of({
      inUse: Effect.succeed(true),
      status: Effect.suspend(() => parseTailscaleStatus(tailscaleJson(tailnet.status))),
      whois: () =>
        Effect.suspend(() =>
          parseTailscaleWhois(tailnet.node === null ? "{}" : tailscaleJson({ Node: tailnet.node })),
        ),
    }),
  );

const layerTest = (
  tailnet: Tailnet,
  overrides: Partial<ServerConfig.ServerConfig["Service"]> = {},
) =>
  TailnetSignIn.layer.pipe(
    Layer.provideMerge(EnvironmentAuth.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerTailscaleHost(tailnet)),
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        ServerConfig.ServerConfig.pipe(
          Effect.map((config) => ({ ...config, tailscaleSignInEnabled: true, ...overrides })),
        ),
      ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-tailnet-test-" }))),
    ),
  );

const makeDpopKey = () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  let proofCount = 0;
  return {
    thumbprint: computeDpopJwkThumbprint(publicJwk),
    sign: (url: string, iat: number) => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const header = encode({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk });
      const payload = encode({ htm: "POST", htu: url, jti: `proof-${++proofCount}`, iat });
      const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
      return `${header}.${payload}.${signature}`;
    },
  };
};

interface RequestShape {
  readonly origin?: string;
  readonly host?: string;
  readonly remoteAddress?: string;
  readonly localAddress?: string;
  readonly dpop?: boolean;
}

const signInRequest = Effect.fn("test.signInRequest")(function* (
  key: ReturnType<typeof makeDpopKey>,
  shape: RequestShape = {},
) {
  const host = shape.host ?? `${HOST_ADDRESS}:3773`;
  const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
  return {
    method: "POST",
    url: "/api/auth/tailnet",
    originalUrl: "/api/auth/tailnet",
    cookies: {},
    headers: {
      host,
      ...(shape.origin === undefined ? {} : { origin: shape.origin }),
      ...(shape.dpop === false ? {} : { dpop: key.sign(`http://${host}/api/auth/tailnet`, iat) }),
    },
    source: {
      socket: {
        remoteAddress: shape.remoteAddress ?? PHONE_ADDRESS,
        localAddress: shape.localAddress ?? HOST_ADDRESS,
        localPort: 3773,
      },
    },
  } as unknown as HttpServerRequest.HttpServerRequest;
});

const signIn = (key: ReturnType<typeof makeDpopKey>, shape?: RequestShape) =>
  Effect.gen(function* () {
    const service = yield* TailnetSignIn.TailnetSignIn;
    return yield* service.signIn(yield* signInRequest(key, shape));
  });

const exchange = (credential: string, key: ReturnType<typeof makeDpopKey>) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* auth.exchangeBootstrapCredentialForAccessToken(
      credential,
      undefined,
      { deviceType: "mobile" },
      { proofKeyThumbprint: key.thumbprint },
    );
  });

const isRefusal = Schema.is(TailnetSignIn.TailnetSignInRefusedError);

/** The refusal reason, or the tag of any other failure. */
const refusalOf = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(
    Effect.map((error): string => (isRefusal(error) ? error.reason : error._tag)),
  );

it.layer(NodeServices.layer)("TailnetSignIn", (it) => {
  it.effect.each<{
    readonly name: string;
    readonly request?: RequestShape;
    readonly status?: JsonObject;
    readonly node?: JsonObject | null;
    readonly config?: Partial<ServerConfig.ServerConfig["Service"]>;
    readonly refused: string;
  }>([
    { name: "sign-in is off", config: { tailscaleSignInEnabled: false }, refused: "disabled" },
    { name: "Origin is null", request: { origin: "null" }, refused: "browser_request" },
    {
      name: "a web page asks",
      request: { origin: "https://evil.example" },
      refused: "browser_request",
    },
    {
      name: "Host is a rebound name",
      request: { host: "evil.example:3773" },
      refused: "browser_request",
    },
    {
      name: "Host names another port",
      request: { host: HOST_ADDRESS },
      refused: "browser_request",
    },
    {
      name: "the peer is not on the tailnet",
      request: { remoteAddress: "192.168.1.5" },
      refused: "not_direct_tailnet",
    },
    {
      name: "the request comes through Serve or Funnel",
      request: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" },
      refused: "not_direct_tailnet",
    },
    {
      name: "it arrives on the LAN interface",
      request: { localAddress: "192.168.1.20" },
      refused: "not_direct_tailnet",
    },
    {
      name: "the proof is missing",
      request: { dpop: false },
      refused: "ServerAuthInvalidCredentialError",
    },
    {
      name: "Tailscale uses userspace networking",
      status: hostStatus({ TUN: false }),
      refused: "tailscale_unavailable",
    },
    {
      name: "Tailscale is too old",
      status: hostStatus({ Version: "1.62.0" }),
      refused: "tailscale_outdated",
    },
    {
      name: "the host is tagged with no owner set",
      status: hostStatus({
        Self: { ID: "nBox", Tags: ["tag:server"], TailscaleIPs: [HOST_ADDRESS] },
      }),
      refused: "owner_unknown",
    },
    {
      name: "the device is tagged",
      node: phoneNode({ Tags: ["tag:ci"] }),
      refused: "tagged_device",
    },
    {
      name: "the device is shared in",
      node: phoneNode({ Sharer: "int64:555" }),
      refused: "shared_device",
    },
    {
      name: "it is this host's own node",
      node: phoneNode({ StableID: "nBox" }),
      refused: "own_node",
    },
    {
      name: "another user owns the device",
      node: phoneNode({ User: `int64:${NEIGHBOR_ID}` }),
      refused: "other_user",
    },
    {
      name: "the device is a subnet router",
      node: phoneNode({
        AllowedIPs: [`${PHONE_ADDRESS}/32`, "192.168.1.0/24"],
        PrimaryRoutes: ["192.168.1.0/24"],
      }),
      refused: "routes_for_others",
    },
    {
      name: "whois leaves out a required field",
      node: { StableID: "nPhone", User: `int64:${OWNER_ID}`, Addresses: [`${PHONE_ADDRESS}/32`] },
      refused: "tailscale_unavailable",
    },
  ])("refuses when $name", ({ request, status, node, config, refused }) =>
    Effect.gen(function* () {
      expect(yield* refusalOf(signIn(makeDpopKey(), request))).toBe(refused);
    }).pipe(
      Effect.provide(
        layerTest({ status: status ?? hostStatus(), node: node ?? phoneNode() }, config),
      ),
    ),
  );

  it.effect.each<{
    readonly name: string;
    readonly request?: RequestShape;
    readonly node?: JsonObject;
  }>([
    { name: "a native app" },
    {
      name: "an exit node",
      node: phoneNode({ AllowedIPs: [`${PHONE_ADDRESS}/32`, "0.0.0.0/0", "::/0"] }),
    },
    { name: "the desktop renderer", request: { origin: "t3code://app" } },
    { name: "an IPv4-mapped peer address", request: { remoteAddress: `::ffff:${PHONE_ADDRESS}` } },
    { name: "the MagicDNS name", request: { host: "box.tail.ts.net:3773" } },
  ])("signs in $name, and the exchange makes a tailnet session", ({ request, node }) =>
    Effect.gen(function* () {
      const key = makeDpopKey();
      const grant = yield* signIn(key, request);
      const token = yield* exchange(grant.credential, key);
      const sessions = yield* SessionStore.SessionStore;
      const session = yield* sessions.verify(token.access_token);
      expect(session).toMatchObject({
        subject: "tailscale:nPhone",
        method: "dpop-access-token",
        proofKeyThumbprint: key.thumbprint,
      });
    }).pipe(Effect.provide(layerTest({ status: hostStatus(), node: node ?? phoneNode() }))),
  );

  it.effect("signs in the configured owner's device on a tagged host", () =>
    Effect.gen(function* () {
      const grant = yield* signIn(makeDpopKey());
      expect(grant.credential).toBeTruthy();
    }).pipe(
      Effect.provide(
        layerTest(
          {
            status: hostStatus({
              Self: { ID: "nBox", Tags: ["tag:server"], TailscaleIPs: [HOST_ADDRESS] },
            }),
            node: phoneNode(),
          },
          { tailscaleOwnerUserId: OWNER_ID },
        ),
      ),
    ),
  );

  it.effect("reruns every check on renewal", () => {
    const tailnet: Tailnet = { status: hostStatus(), node: phoneNode() };
    return Effect.gen(function* () {
      const key = makeDpopKey();
      yield* signIn(key);
      tailnet.node = phoneNode({ Tags: ["tag:agents"] });
      expect(yield* refusalOf(signIn(key))).toBe("tagged_device");
      tailnet.node = null;
      expect(yield* refusalOf(signIn(key))).toBe("tailscale_unavailable");
    }).pipe(Effect.provide(layerTest(tailnet)));
  });

  it.effect("blocking ends live sessions and refuses a grant minted before the block", () =>
    Effect.gen(function* () {
      const service = yield* TailnetSignIn.TailnetSignIn;
      const sessions = yield* SessionStore.SessionStore;
      const key = makeDpopKey();
      const live = yield* exchange((yield* signIn(key)).credential, key);
      const pending = yield* signIn(key);

      expect(yield* service.blockDevice("nPhone")).toBe(1);
      expect((yield* Effect.flip(sessions.verify(live.access_token)))._tag).toBe(
        "SessionTokenRevokedError",
      );
      expect(yield* refusalOf(exchange(pending.credential, key))).toBe(
        "ServerAuthInvalidCredentialError",
      );
      expect(yield* refusalOf(signIn(key))).toBe("blocked");
      expect(yield* service.listDevices("tailscale:nPhone")).toMatchObject([
        { stableNodeId: "nPhone", label: "phone", activeSessionCount: 0, current: true },
      ]);

      expect(yield* service.unblockDevice("nPhone")).toBe(true);
      const renewed = yield* exchange((yield* signIn(key)).credential, key);
      expect((yield* sessions.verify(renewed.access_token)).subject).toBe("tailscale:nPhone");
      expect(yield* service.listDevices("bearer:laptop")).toMatchObject([
        { stableNodeId: "nPhone", blockedAt: null, activeSessionCount: 1, current: false },
      ]);
    }).pipe(Effect.provide(layerTest({ status: hostStatus(), node: phoneNode() }))),
  );
});
