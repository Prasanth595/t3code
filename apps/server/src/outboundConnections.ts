import * as NodeNet from "node:net";

/**
 * Time each address gets to finish its TCP connect before Node's Happy Eyeballs
 * (`autoSelectFamily`) gives up on it for the next one. Node drops the earlier
 * attempt instead of racing it, so a connect slower than this never succeeds:
 * with Node 24's 250 ms default, a dual-stack host behind unroutable IPv6 and a
 * ~400 ms IPv4 connect fails with `AggregateError` long before any request
 * timeout. 1 s covers slow-but-working links (satellite, cellular, far regions)
 * and stays within RFC 8305's 2 s ceiling. Fast connects are unaffected.
 */
const OUTBOUND_CONNECT_ATTEMPT_TIMEOUT_MS = 1_000;

const attemptTimeoutFlag = "--network-family-autoselection-attempt-timeout";

/**
 * Raises this process's default per-address connect allowance for every
 * outbound socket it opens (`fetch`, WebSockets, `https`). Called once at CLI
 * startup. It changes only this process: `NODE_OPTIONS` is untouched, so
 * provider CLIs, terminals and package managers keep Node's own default. An
 * explicit Node flag, on the command line or in `NODE_OPTIONS`, wins.
 */
export function allowSlowOutboundConnections(): void {
  // Node accepts `_` and `-` interchangeably in option names.
  const configuredByUser = [...process.execArgv, process.env.NODE_OPTIONS ?? ""].some((option) =>
    option.replaceAll("_", "-").includes(attemptTimeoutFlag),
  );
  if (configuredByUser) return;
  if (NodeNet.getDefaultAutoSelectFamilyAttemptTimeout() >= OUTBOUND_CONNECT_ATTEMPT_TIMEOUT_MS) {
    return;
  }
  NodeNet.setDefaultAutoSelectFamilyAttemptTimeout(OUTBOUND_CONNECT_ATTEMPT_TIMEOUT_MS);
}
