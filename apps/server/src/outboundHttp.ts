import * as NodeModule from "node:module";
import * as NodeNet from "node:net";

import type * as Undici from "undici";

// undici stays external to the CLI bundle (scripts/lib/cli-external-packages.ts).
// Inside a Node single-executable only `require` can load it from disk.
const requireUndici = NodeModule.createRequire(import.meta.url);

/**
 * Node 26 bundles undici 8, which offers h2 over ALPN to every HTTPS origin.
 * Node 22/24 (and Electron) bundle undici 6/7, whose fetch stays on HTTP/1.1.
 */
export const builtinFetchUsesHttp2 = (bundledUndiciVersion: string | undefined) =>
  Number.parseInt(bundledUndiciVersion ?? "", 10) >= 8;

/**
 * Servers this process spawns or forwards (provider servers, device hubs and
 * daemons, SSH forwards, preview probes) all live on loopback. The env proxy
 * agent proxies them like any other origin unless `NO_PROXY` lists them, and a
 * proxy that cannot reach the client's loopback then hides every one of them.
 */
const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,[::1]";

/**
 * `NO_PROXY` as undici reads it (lowercase name first) with loopback appended,
 * or `undefined` when `*` already bypasses everything.
 */
export const noProxyWithLoopback = (env: NodeJS.ProcessEnv): string | undefined => {
  const configured = (env.no_proxy ?? env.NO_PROXY ?? "").trim();
  if (configured === "*") return undefined;
  return configured.length > 0 ? `${configured},${LOOPBACK_NO_PROXY}` : LOOPBACK_NO_PROXY;
};

// Node's agent comes from its internal undici copy, so `instanceof` against the npm class is false.
const isEnvHttpProxyAgent = (
  dispatcher: Undici.Dispatcher | undefined,
): dispatcher is Undici.Dispatcher => dispatcher?.constructor.name === "EnvHttpProxyAgent";

/**
 * Node's `--use-env-proxy` / `NODE_USE_ENV_PROXY` installs an
 * `EnvHttpProxyAgent` at startup; that choice is kept so proxies still apply.
 */
export function installHttp1FetchDispatcher(): void {
  const undici = requireUndici("undici") as typeof Undici;
  const usesEnvProxy = isEnvHttpProxyAgent(undici.getGlobalDispatcher());
  const noProxy = usesEnvProxy ? noProxyWithLoopback(process.env) : undefined;
  undici.setGlobalDispatcher(
    usesEnvProxy
      ? new undici.EnvHttpProxyAgent({
          allowH2: false,
          // The connection to an HTTPS proxy is built here, not from `allowH2`. ProxyAgent's
          // `connect` option is dropped on purpose: its connector has h2 fixed on.
          clientFactory: (origin) => new undici.Pool(origin, { allowH2: false }),
          ...(noProxy === undefined ? {} : { noProxy }),
        })
      : new undici.Agent({ allowH2: false }),
  );
}

// undici 7 reads the first symbol; undici 7 and 8 write both. The npm copy is
// not loaded here: on a runtime that bundles undici 6 its module init would
// replace Node's env proxy agent with a plain npm Agent.
const GLOBAL_DISPATCHER_SYMBOLS = [
  Symbol.for("undici.globalDispatcher.1"),
  Symbol.for("undici.globalDispatcher.2"),
] as const;
type GlobalDispatchers = Record<
  (typeof GLOBAL_DISPATCHER_SYMBOLS)[number],
  Undici.Dispatcher | undefined
>;

/**
 * Rebuilds Node's env proxy agent with loopback in its bypass list. The class
 * is taken from the installed instance rather than the npm package: Node's
 * bundled undici can differ in major version, and its fetch only dispatches
 * safely through its own classes. `process.env` is left alone, so provider
 * and terminal children keep the user's `NO_PROXY`.
 */
export function keepLoopbackOffEnvProxy(): void {
  const globals = globalThis as unknown as GlobalDispatchers;
  const current = globals[GLOBAL_DISPATCHER_SYMBOLS[0]];
  if (!isEnvHttpProxyAgent(current)) return;
  const noProxy = noProxyWithLoopback(process.env);
  if (noProxy === undefined) return;
  const EnvHttpProxyAgent = current.constructor as new (
    options: Undici.EnvHttpProxyAgent.Options,
  ) => Undici.Dispatcher;
  const replacement = new EnvHttpProxyAgent({ noProxy });
  for (const symbol of GLOBAL_DISPATCHER_SYMBOLS) {
    if (globals[symbol] === current) globals[symbol] = replacement;
  }
  void current.close();
}

/**
 * An undici HTTP/2 session that hits its idle timeout can emit `'error'` on a
 * stream with no listener, which Node turns into an uncaught exception that
 * exits the server (https://github.com/nodejs/undici/issues/5936). The HTTP/1
 * dispatcher carries the loopback bypass itself; older runtimes get it alone.
 */
export function configureOutboundFetch(): void {
  if (builtinFetchUsesHttp2(process.versions.undici)) installHttp1FetchDispatcher();
  else keepLoopbackOffEnvProxy();
}

/**
 * Node's 250 ms Happy Eyeballs attempt timeout abandons a working-but-slow IPv4
 * connect when IPv6 is advertised but unroutable, which broke the ACP registry
 * fetch (#15039). A larger `--network-family-autoselection-attempt-timeout` still wins.
 */
export function extendConnectionAttemptTimeout(): void {
  NodeNet.setDefaultAutoSelectFamilyAttemptTimeout(
    Math.max(NodeNet.getDefaultAutoSelectFamilyAttemptTimeout(), 1_000),
  );
}
