import {
  MachineId,
  type MachineMapDocument,
  type MachineRecord,
} from "@t3tools/contracts/machineMap";

import { emptyMap } from "./map.ts";

export const MAC = MachineId.make("mac");
export const VPS = MachineId.make("vps");
export const WIN = MachineId.make("win");

export const machine = (id: MachineId, overrides: Partial<MachineRecord> = {}): MachineRecord => ({
  id,
  name: id.toUpperCase(),
  kind: "server",
  tokenClientId: `${id}.access`,
  hostname: `${id}.example.com`,
  position: { x: 0.5, y: 0.5 },
  mapRole: "none",
  createdAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

/** Three machines and no arrows. */
export const threeMachines = (): MachineMapDocument => ({
  ...emptyMap(),
  machines: [machine(MAC), machine(VPS), machine(WIN)],
});
