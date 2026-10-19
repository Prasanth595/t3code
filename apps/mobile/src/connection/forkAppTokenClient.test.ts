import { EnvironmentId, MachineId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  appTokenOrigins,
  isRefusedSession,
  planMachineSync,
  repairDelayMs,
} from "./forkAppTokenClient";

const mac = { id: MachineId.make("mac"), name: "Mac", origin: "https://mac.example.com" };
const vps = { id: MachineId.make("vps"), name: "VPS", origin: "https://vps.example.com" };
const macEnvironment = EnvironmentId.make("environment-mac");
const vpsEnvironment = EnvironmentId.make("environment-vps");

describe("planMachineSync", () => {
  it("pairs a listed machine that no environment reaches, and disables an unlisted one", () => {
    const plan = planMachineSync({
      machines: [vps],
      saved: [{ environmentId: macEnvironment, origin: mac.origin, enabled: true }],
      disabledByRepair: new Set(),
    });
    expect(plan.pair).toEqual([vps]);
    expect(plan.disable).toEqual([macEnvironment]);
    expect(plan.enable).toEqual([]);
  });

  it("enables again only the environments that the repair disabled", () => {
    const plan = planMachineSync({
      machines: [mac, vps],
      saved: [
        { environmentId: macEnvironment, origin: mac.origin, enabled: false },
        { environmentId: vpsEnvironment, origin: vps.origin, enabled: false },
      ],
      disabledByRepair: new Set([macEnvironment]),
    });
    expect(plan.enable).toEqual([macEnvironment]);
    expect(plan.pair).toEqual([]);
  });
});

describe("repairDelayMs", () => {
  it("grows from 30 seconds and stops at 10 minutes", () => {
    expect(repairDelayMs(1)).toBe(30_000);
    expect(repairDelayMs(2)).toBe(60_000);
    expect(repairDelayMs(20)).toBe(600_000);
  });
});

describe("appTokenOrigins", () => {
  it("keeps the origins that hold the service token of the client", () => {
    const token = (clientId: string) => [
      { name: "CF-Access-Client-Id", value: clientId },
      { name: "CF-Access-Client-Secret", value: "secret" },
    ];
    expect(
      appTokenOrigins(
        [
          { origin: mac.origin, headers: token("app.access") },
          { origin: vps.origin, headers: token("other.access") },
        ],
        "app.access",
      ),
    ).toEqual(new Set([mac.origin]));
  });
});

describe("isRefusedSession", () => {
  it("repairs a refused session, not a pause or a retry", () => {
    expect(isRefusedSession({ phase: "blocked", lastFailure: { reason: "authentication" } })).toBe(
      true,
    );
    // The pause keeps the session: the machine answers it as a transient failure (MM-718).
    expect(
      isRefusedSession({ phase: "backoff", lastFailure: { reason: "remote-unavailable" } }),
    ).toBe(false);
    expect(isRefusedSession({ phase: "blocked", lastFailure: { reason: "permission" } })).toBe(
      false,
    );
    expect(isRefusedSession({ phase: "connecting", lastFailure: null })).toBe(false);
  });
});
