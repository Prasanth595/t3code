import { describe, expect, it } from "@effect/vitest";
import { AuthStandardClientScopes, ClientId, MACHINE_LEVEL_SCOPES } from "@t3tools/contracts";

import {
  clientGrantFor,
  clientsWithChangedLevel,
  machineGrantFor,
  machineMcpAccessFor,
  peersWithChangedLevel,
  reachablePeers,
} from "./machineAccess.ts";
import { PEER, PEER_TOKEN, SELF, arrow, desiredState } from "./MachineMap.testkit.ts";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
/** When a desired state with an arrow that expires at 11:00 arrived. */
const BEFORE_EXPIRY = Date.parse("2026-10-13T10:00:00.000Z");

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

describe("clientGrantFor (MM-912)", () => {
  it("gives an app token its client level, ends at expiry, and ends when the client goes", () => {
    const PHONE = ClientId.make("client-phone");
    const withPhone = (level: "standard" | "admin", expiresAt: string | null = null) => ({
      ...desiredState({}),
      clients: [
        {
          id: PHONE,
          name: "Phone",
          tokenClientId: "phone.access",
          level,
          expiresAt,
          revertLevel: expiresAt === null ? null : ("none" as const),
        },
      ],
    });
    expect(clientGrantFor(withPhone("standard"), "phone.access", NOW)).toEqual({
      subject: "client:client-phone",
      scopes: AuthStandardClientScopes,
      label: "client Phone",
    });
    expect(clientGrantFor(withPhone("standard"), PEER_TOKEN, NOW)).toBeUndefined();
    expect(
      clientGrantFor(withPhone("admin", "2026-10-13T11:00:00.000Z"), "phone.access", NOW),
    ).toBeUndefined();
    expect(clientsWithChangedLevel(withPhone("standard"), null, desiredState({}), NOW)).toEqual([
      PHONE,
    ]);
    // The portal drops an expired client from the desired state; its sessions still end.
    expect(
      clientsWithChangedLevel(
        withPhone("admin", "2026-10-13T11:00:00.000Z"),
        BEFORE_EXPIRY,
        desiredState({}),
        NOW,
      ),
    ).toEqual([PHONE]);
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
      peersWithChangedLevel(
        before,
        null,
        desiredState({ arrowsIn: [arrow(PEER, SELF, "read")] }),
        NOW,
      ),
    ).toEqual([PEER]);
    expect(peersWithChangedLevel(before, null, desiredState({}), NOW)).toEqual([PEER]);
  });

  it("ends the sessions of an arrow that expired before the next desired state", () => {
    // The portal reverts the arrow at expiry. Both states then read `none` at the current time,
    // but the sessions still hold the level they got before the expiry.
    const expiring = desiredState({
      arrowsIn: [
        arrow(PEER, SELF, "standard", {
          expiresAt: "2026-10-13T11:00:00.000Z",
          revertLevel: "none",
        }),
      ],
    });
    expect(peersWithChangedLevel(expiring, BEFORE_EXPIRY, desiredState({}), NOW)).toEqual([PEER]);
  });

  it("keeps sessions issued at the revert level when the old state arrived after the expiry", () => {
    // The portal was offline at the expiry, so the state arrived already expired and the sessions
    // got the revert level. The next state with the reverted arrow changes nothing for them.
    const expired = desiredState({
      arrowsIn: [
        arrow(PEER, SELF, "admin", { expiresAt: "2026-10-13T11:00:00.000Z", revertLevel: "read" }),
      ],
    });
    const reverted = desiredState({ arrowsIn: [arrow(PEER, SELF, "read")] });
    expect(peersWithChangedLevel(expired, NOW - 60_000, reverted, NOW)).toEqual([]);
  });

  it("ignores agent tools and arrows out of this machine", () => {
    const before = desiredState({ arrowsIn: [arrow(PEER, SELF, "read")] });
    const next = desiredState({
      arrowsIn: [arrow(PEER, SELF, "read", { agentTools: true })],
      arrowsOut: [arrow(SELF, PEER, "admin")],
    });
    expect(peersWithChangedLevel(before, null, next, NOW)).toEqual([]);
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
