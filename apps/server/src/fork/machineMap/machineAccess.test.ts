import { describe, expect, it } from "@effect/vitest";
import { AuthStandardClientScopes, MACHINE_LEVEL_SCOPES } from "@t3tools/contracts";

import {
  machineGrantFor,
  machineMcpAccessFor,
  peersWithChangedLevel,
  reachablePeers,
} from "./machineAccess.ts";
import { PEER, PEER_TOKEN, SELF, arrow, desiredState } from "./MachineMap.testkit.ts";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");

describe("machineGrantFor (MM-1305)", () => {
  it("gives a peer token the scopes of its arrow and the subject machine:<id>", () => {
    const desired = desiredState({ arrowsIn: [arrow(PEER, SELF, "standard")] });
    expect(machineGrantFor(desired, PEER_TOKEN, NOW)).toEqual({
      subject: `machine:${PEER}`,
      scopes: AuthStandardClientScopes,
      label: "machine VPS",
    });
  });

  it("gives nothing for level none, an unknown token, or an arrow out of this machine", () => {
    expect(
      machineGrantFor(desiredState({ arrowsIn: [arrow(PEER, SELF, "none")] }), PEER_TOKEN, NOW),
    ).toBeUndefined();
    expect(
      machineGrantFor(desiredState({ arrowsIn: [arrow(PEER, SELF, "admin")] }), "other", NOW),
    ).toBeUndefined();
    expect(
      machineGrantFor(desiredState({ arrowsOut: [arrow(SELF, PEER, "admin")] }), PEER_TOKEN, NOW),
    ).toBeUndefined();
  });

  it("enforces an expired arrow at its revert level, even before the portal revises it", () => {
    const expired = (revertLevel: "read" | null) =>
      desiredState({
        arrowsIn: [
          arrow(PEER, SELF, "admin", { expiresAt: "2026-10-13T11:00:00.000Z", revertLevel }),
        ],
      });
    expect(machineGrantFor(expired("read"), PEER_TOKEN, NOW)?.scopes).toEqual(
      MACHINE_LEVEL_SCOPES.read,
    );
    expect(machineGrantFor(expired(null), PEER_TOKEN, NOW)).toBeUndefined();
  });
});

describe("machineMcpAccessFor (MM-1307)", () => {
  const subject = `machine:${PEER}`;

  it("admits a machine session only when its arrow has agent tools", () => {
    expect(
      machineMcpAccessFor(desiredState({ arrowsIn: [arrow(PEER, SELF, "admin")] }), subject, NOW),
    ).toBeUndefined();
    expect(
      machineMcpAccessFor(
        desiredState({ arrowsIn: [arrow(PEER, SELF, "standard", { agentTools: true })] }),
        subject,
        NOW,
      )?.access,
    ).toBe("full-access");
  });

  it("keeps a read arrow read-only, and ignores other subjects", () => {
    const desired = desiredState({
      arrowsIn: [arrow(PEER, SELF, "read", { agentTools: true })],
    });
    expect(machineMcpAccessFor(desired, subject, NOW)?.access).toBe("read-only");
    expect(machineMcpAccessFor(desired, "one-time-token", NOW)).toBeUndefined();
  });
});

describe("peersWithChangedLevel (MM-1306)", () => {
  it("lists a peer whose level into this machine changed, or that left the map", () => {
    const before = desiredState({ arrowsIn: [arrow(PEER, SELF, "admin")] });
    expect(
      peersWithChangedLevel(before, desiredState({ arrowsIn: [arrow(PEER, SELF, "read")] }), NOW),
    ).toEqual([PEER]);
    expect(peersWithChangedLevel(before, desiredState({}), NOW)).toEqual([PEER]);
  });

  it("ignores agent tools and arrows out of this machine", () => {
    const before = desiredState({ arrowsIn: [arrow(PEER, SELF, "read")] });
    const next = desiredState({
      arrowsIn: [arrow(PEER, SELF, "read", { agentTools: true })],
      arrowsOut: [arrow(SELF, PEER, "admin")],
    });
    expect(peersWithChangedLevel(before, next, NOW)).toEqual([]);
  });
});

describe("reachablePeers (MM-306)", () => {
  it("lists peers above none with a hostname, with their origin", () => {
    const reachable = reachablePeers(
      desiredState({ arrowsOut: [arrow(SELF, PEER, "read", { agentTools: true })] }),
      NOW,
    );
    expect(reachable).toMatchObject([
      {
        machine: { id: PEER },
        level: "read",
        agentTools: true,
        origin: `https://t3-vps.example.com`,
      },
    ]);
    expect(reachablePeers(desiredState({ arrowsOut: [arrow(SELF, PEER, "none")] }), NOW)).toEqual(
      [],
    );
  });
});
