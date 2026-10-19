// @effect-diagnostics nodeBuiltinImport:off - the test runs a real TLS h2 server to see which protocol fetch negotiates.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeHttp2 from "node:http2";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as Undici from "undici";
import { afterAll, afterEach, beforeAll, describe, expect } from "vite-plus/test";

import {
  builtinFetchUsesHttp2,
  extendConnectionAttemptTimeout,
  installHttp1FetchDispatcher,
  noProxyWithLoopback,
} from "./outboundHttp.ts";

// Test-only self-signed P-256 certificate for 127.0.0.1, valid until 2126; not a
// secret. Node cannot mint X.509 certificates without a library, and a local
// server only offers h2 over ALPN, which needs TLS.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg3EwCztQysKTvzdcR
g0LWq+axzUd4tHi9PyMdqh7PlGShRANCAARfQpoLgv/tOsHWCLriDza7Ruaey2b7
mR/nS6mLu6W7+agkEqDm0mE3F/ngpPjL4Jj0IGadeMcKNKFRSBgiLdfn
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBsDCCAVagAwIBAgIUWbn2Wt5kTxii1UU57NJMt/wTaUgwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZdDNjb2RlIG91dGJvdW5kIGh0dHAgdGVzdDAgFw0yNjEwMTEy
MjQyMzZaGA8yMTI2MDkxNzIyNDIzNlowJDEiMCAGA1UEAwwZdDNjb2RlIG91dGJv
dW5kIGh0dHAgdGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABF9CmguC/+06
wdYIuuIPNrtG5p7LZvuZH+dLqYu7pbv5qCQSoObSYTcX+eCk+MvgmPQgZp14xwo0
oVFIGCIt1+ejZDBiMB0GA1UdDgQWBBSsekAc30Q/zdIE/tvVDQKJL5oiCDAfBgNV
HSMEGDAWgBSsekAc30Q/zdIE/tvVDQKJL5oiCDAPBgNVHRMBAf8EBTADAQH/MA8G
A1UdEQQIMAaHBH8AAAEwCgYIKoZIzj0EAwIDSAAwRQIgebUrkyP56242EJB7nCV7
A+Ke/q0rNPya3fjQa9O5B+kCIQC1SfmdNaFcNJ4JINlus4FfrRnfKiADS2MIJR9f
99BN0A==
-----END CERTIFICATE-----
`;

const server = NodeHttp2.createSecureServer(
  { allowHTTP1: true, key: TEST_KEY, cert: TEST_CERT },
  (request, response) => response.end(request.httpVersion),
);
let origin = "";
const defaultCaCertificates = NodeTls.getCACertificates("default");
const defaultDispatcher = Undici.getGlobalDispatcher();
const defaultAttemptTimeout = NodeNet.getDefaultAutoSelectFamilyAttemptTimeout();

beforeAll(async () => {
  NodeTls.setDefaultCACertificates([...defaultCaCertificates, TEST_CERT]);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}/`;
});

afterEach(() => {
  Undici.setGlobalDispatcher(defaultDispatcher);
  NodeNet.setDefaultAutoSelectFamilyAttemptTimeout(defaultAttemptTimeout);
});

afterAll(async () => {
  NodeTls.setDefaultCACertificates(defaultCaCertificates);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const versionViaGlobalDispatcher = async () => (await Undici.request(origin)).body.text();

const versionViaBuiltinFetch = () =>
  HttpClient.get(origin).pipe(
    Effect.flatMap((response) => response.text),
    Effect.provide(FetchHttpClient.layer),
  );

describe("installHttp1FetchDispatcher", () => {
  it("makes the global dispatcher negotiate HTTP/1.1 and keeps the env proxy agent", async () => {
    Undici.setGlobalDispatcher(new Undici.Agent());
    expect(await versionViaGlobalDispatcher()).toBe("2.0");

    installHttp1FetchDispatcher();
    expect(await versionViaGlobalDispatcher()).toBe("1.1");

    Undici.setGlobalDispatcher(new Undici.EnvHttpProxyAgent());
    installHttp1FetchDispatcher();
    expect(Undici.getGlobalDispatcher()).toBeInstanceOf(Undici.EnvHttpProxyAgent);
  });

  // Only a runtime that bundles undici 8 (Node 26+) offers h2 through the
  // built-in fetch, so only there can this prove fetch reads the new dispatcher.
  it.effect.runIf(builtinFetchUsesHttp2(process.versions.undici))(
    "moves the built-in fetch off HTTP/2",
    () =>
      Effect.gen(function* () {
        expect(yield* versionViaBuiltinFetch()).toBe("2.0");
        installHttp1FetchDispatcher();
        expect(yield* versionViaBuiltinFetch()).toBe("1.1");
      }),
  );
});

describe("noProxyWithLoopback", () => {
  it("adds loopback to the configured bypass list and keeps the wildcard", () => {
    expect(noProxyWithLoopback({})).toBe("localhost,127.0.0.1,[::1]");
    expect(noProxyWithLoopback({ NO_PROXY: "corp.example" })).toBe(
      "corp.example,localhost,127.0.0.1,[::1]",
    );
    expect(noProxyWithLoopback({ NO_PROXY: "corp.example", no_proxy: "" })).toBe(
      "localhost,127.0.0.1,[::1]",
    );
    expect(noProxyWithLoopback({ NO_PROXY: "*" })).toBeUndefined();
  });
});

const listenHttp = (server: NodeHttp.Server) =>
  Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.listen(0, "127.0.0.1", () =>
        resume(Effect.succeed((server.address() as NodeNet.AddressInfo).port)),
      );
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );

/**
 * A proxy that answers every request itself and records the authority asked
 * for. undici 7 reaches an HTTP proxy with a CONNECT tunnel and undici 8 with
 * an absolute-form request, so both are served and the body is the proof.
 */
const recordingProxy = Effect.gen(function* () {
  const authorities: string[] = [];
  const proxy = NodeHttp.createServer((request, response) => {
    authorities.push(request.headers.host ?? "");
    response.end("proxied");
  });
  proxy.on("connect", (request, socket, head) => {
    authorities.push(request.url ?? "");
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const answer = () =>
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied");
    if (head.length > 0) answer();
    else socket.once("data", answer);
  });
  const port = yield* listenHttp(proxy);
  return { authorities, url: `http://127.0.0.1:${port}` };
});

const USE_ENV_PROXY_PROBE = `
const { configureOutboundFetch } = await import(process.env.OUTBOUND_HTTP_MODULE);
configureOutboundFetch();
const probe = async (url) => {
  try {
    return await (await fetch(url)).text();
  } catch (error) {
    return "error:" + String(error.cause ?? error);
  }
};
console.log(JSON.stringify({
  loopback: await probe(process.env.LOOPBACK_URL),
  external: await probe(process.env.EXTERNAL_URL),
  noProxy: process.env.NO_PROXY,
}));
`;

// Only Node's own `--use-env-proxy` installs the agent class its fetch
// dispatches through, so the probe runs in a child Node process.
const probeWithEnvProxy = (env: Record<string, string>) =>
  Effect.callback<{ loopback: string; external: string; noProxy: string }>((resume) => {
    NodeChildProcess.execFile(
      process.execPath,
      ["--use-env-proxy", "--input-type=module", "--eval", USE_ENV_PROXY_PROBE],
      {
        env: {
          PATH: process.env.PATH,
          OUTBOUND_HTTP_MODULE: new URL("./outboundHttp.ts", import.meta.url).href,
          ...env,
        },
      },
      (error, stdout, stderr) =>
        resume(
          error
            ? Effect.die(new Error(`probe failed: ${error.message}\n${stderr}`))
            : Effect.succeed(JSON.parse(stdout)),
        ),
    );
  });

describe("configureOutboundFetch", () => {
  it.effect("keeps loopback off the env proxy while external requests still use it", () =>
    Effect.gen(function* () {
      const proxy = yield* recordingProxy;
      const port = yield* listenHttp(
        NodeHttp.createServer((_request, response) => response.end("direct")),
      );
      const result = yield* probeWithEnvProxy({
        HTTP_PROXY: proxy.url,
        NO_PROXY: "corp.example",
        LOOPBACK_URL: `http://127.0.0.1:${port}/`,
        EXTERNAL_URL: `http://external-proof.invalid:${port}/`,
      });
      expect(result).toEqual({ loopback: "direct", external: "proxied", noProxy: "corp.example" });
      expect(proxy.authorities).toEqual([`external-proof.invalid:${port}`]);
    }),
  );
});

describe("extendConnectionAttemptTimeout", () => {
  it("raises a default below the floor to 1000 ms", () => {
    NodeNet.setDefaultAutoSelectFamilyAttemptTimeout(50);
    extendConnectionAttemptTimeout();
    expect(NodeNet.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(1_000);
  });

  it("keeps a larger configured timeout", () => {
    NodeNet.setDefaultAutoSelectFamilyAttemptTimeout(5_000);
    extendConnectionAttemptTimeout();
    expect(NodeNet.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(5_000);
  });
});
