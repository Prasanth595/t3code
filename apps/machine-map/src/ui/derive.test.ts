import { describe, expect, it } from "vite-plus/test";
import type { MachinePresence, PortalSnapshot } from "@t3tools/contracts/machineMap";

import { applyChanges, findArrow } from "../rules/map.ts";
import { MAC, threeMachines, VPS } from "../rules/testMap.ts";
import { machineQueue } from "./derive.ts";

describe("machineQueue (MM-602)", () => {
  const map = threeMachines();
  const changes = [
    { _tag: "setArrow" as const, arrow: { ...findArrow(map, MAC, VPS), level: "read" as const } },
  ];
  const snapshot = (presence: MachinePresence): PortalSnapshot => ({
    map,
    presence: { [MAC]: presence },
    reportedSettings: {},
    commands: [],
    history: [
      {
        revision: 1,
        at: "2026-10-13T08:00:00.000Z",
        actor: { _tag: "portal", reason: "test" },
        summary: "s",
        changes,
        inverse: applyChanges(map, changes).inverse,
      },
    ],
    proposals: [],
  });
  const mac = map.machines[0]!;

  it("does not count work for a machine that never joined", () => {
    const queue = machineQueue(
      snapshot({ online: false, lastSeenAt: null, appliedRevision: null, status: null }),
      [],
      mac,
    );
    expect(queue.waitingToJoin).toBe(true);
    expect(queue.count).toBe(0);
  });

  it("counts work for a machine that joined once and is now offline", () => {
    const queue = machineQueue(
      snapshot({
        online: false,
        lastSeenAt: "2026-10-12T08:00:00.000Z",
        appliedRevision: null,
        status: null,
      }),
      [],
      mac,
    );
    expect(queue.waitingToJoin).toBe(false);
    expect(queue.count).toBe(1);
  });
});
