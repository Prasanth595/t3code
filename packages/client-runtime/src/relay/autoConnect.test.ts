import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { environmentsToAutoConnect } from "./autoConnect.ts";
import type { RelayDiscoveredEnvironment } from "./discovery.ts";

const discovered = (id: string, availability: RelayDiscoveredEnvironment["availability"]) =>
  [
    id,
    {
      environment: {
        environmentId: EnvironmentId.make(id),
        label: id,
        endpoint: {
          httpBaseUrl: `https://${id}.example`,
          wsBaseUrl: `wss://${id}.example`,
          providerKind: "cloudflare_tunnel",
        },
        linkedAt: "2026-10-01T00:00:00.000Z",
      },
      availability,
      status: Option.none(),
      error: Option.none(),
    } satisfies RelayDiscoveredEnvironment,
  ] as const;

describe("environmentsToAutoConnect", () => {
  it("adds only the account's other computers that are new and done checking", () => {
    const result = environmentsToAutoConnect({
      discovered: new Map([
        discovered("this-mac", "online"),
        discovered("saved", "online"),
        discovered("removed", "online"),
        discovered("pending", "checking"),
        discovered("offline-pc", "offline"),
        discovered("laptop", "online"),
      ]),
      savedEnvironmentIds: new Set(["saved"]),
      localEnvironmentId: "this-mac",
      previouslyAdded: new Set(["removed"]),
    });
    expect(result.map((environment) => environment.environmentId)).toEqual([
      "offline-pc",
      "laptop",
    ]);
  });
});
