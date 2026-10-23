import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SavedRemoteConnection } from "../lib/connection";
import { FACTORY_RELAY_ONLY_MESSAGE, factoryEnvironmentChoice } from "./factoryEnvironments";

function connection(
  label: string,
  extra: Partial<SavedRemoteConnection> = {},
): SavedRemoteConnection {
  return {
    environmentId: `env-${label}` as EnvironmentId,
    environmentLabel: label,
    pairingUrl: "",
    displayUrl: "",
    httpBaseUrl: `https://${label}.example.ts.net`,
    wsBaseUrl: `wss://${label}.example.ts.net`,
    bearerToken: "bearer",
    ...extra,
  };
}

describe("factoryEnvironmentChoice", () => {
  it("is none without connections", () => {
    expect(factoryEnvironmentChoice([])).toEqual({ kind: "none" });
  });

  it("is relay-only when every connection is relay managed or DPoP", () => {
    const choice = factoryEnvironmentChoice([
      connection("a", { relayManaged: true }),
      connection("b", { authenticationMethod: "dpop" }),
    ]);
    expect(choice).toEqual({ kind: "relay-only" });
  });

  it("opens the only direct connection and ignores relay ones", () => {
    const direct = connection("direct");
    const choice = factoryEnvironmentChoice([connection("relay", { relayManaged: true }), direct]);
    expect(choice).toEqual({ kind: "one", connection: direct });
  });

  it("lists several direct connections sorted by label", () => {
    const choice = factoryEnvironmentChoice([
      connection("zeta"),
      connection("Alpha"),
      connection("mid"),
      connection("relay", { relayManaged: true }),
    ]);
    expect(choice.kind).toBe("several");
    if (choice.kind === "several") {
      expect(choice.connections.map((c) => c.environmentLabel)).toEqual(["Alpha", "mid", "zeta"]);
    }
  });

  it("states the relay message from the issue", () => {
    expect(FACTORY_RELAY_ONLY_MESSAGE).toBe(
      "Factory pages need a direct connection. Pair this phone with the server over the tailnet.",
    );
  });
});
