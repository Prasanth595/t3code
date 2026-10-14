import { describe, expect, it } from "vite-plus/test";
import type { MachineMapDocument } from "@t3tools/contracts/machineMap";

import {
  arrowChange,
  arrowRaises,
  decideAgentWrite,
  gateTool,
  raisesAnyAccess,
  raisesOwnAccess,
} from "./access.ts";
import { applyChanges, findArrow } from "./map.ts";
import { MAC, machine, threeMachines, VPS } from "./testMap.ts";

const withRole = (role: "none" | "read" | "propose" | "edit"): MachineMapDocument => ({
  ...threeMachines(),
  machines: threeMachines().machines.map((m) => (m.id === MAC ? { ...m, mapRole: role } : m)),
});

describe("arrowChange", () => {
  it("returns a temporary level to the first permanent level (MM-304)", () => {
    let map = threeMachines();
    const first = arrowChange(map, {
      from: MAC,
      to: VPS,
      level: "read",
      expiresAt: "2026-10-13T10:00:00.000Z",
    });
    map = applyChanges(map, [first]).map;
    const second = arrowChange(map, {
      from: MAC,
      to: VPS,
      level: "admin",
      expiresAt: "2026-10-13T11:00:00.000Z",
    });
    expect(second._tag === "setArrow" && second.arrow.revertLevel).toBe("none");
    const permanent = arrowChange(map, { from: MAC, to: VPS, level: "standard", expiresAt: null });
    expect(permanent._tag === "setArrow" && permanent.arrow).toMatchObject({
      level: "standard",
      expiresAt: null,
      revertLevel: null,
    });
  });
});

describe("self-escalation (MM-803)", () => {
  const base = findArrow(threeMachines(), MAC, VPS);

  it("flags more access now, later, or for longer", () => {
    expect(arrowRaises(base, { ...base, level: "read" })).toBe(true);
    expect(arrowRaises(base, { ...base, agentTools: true })).toBe(true);
    const temporary = {
      ...base,
      level: "admin" as const,
      expiresAt: "2026-10-13T10:00:00.000Z",
      revertLevel: "none" as const,
    };
    expect(arrowRaises(temporary, { ...temporary, expiresAt: "2026-10-14T10:00:00.000Z" })).toBe(
      true,
    );
    expect(arrowRaises(temporary, { ...temporary, expiresAt: null, revertLevel: null })).toBe(true);
    expect(arrowRaises({ ...base, level: "admin" }, { ...base, level: "read" })).toBe(false);
  });

  it("covers arrows from the machine and its map role, not other arrows", () => {
    const map = threeMachines();
    const raiseOwn = { _tag: "setArrow" as const, arrow: { ...base, level: "admin" as const } };
    const raiseOther = {
      _tag: "setArrow" as const,
      arrow: { ...findArrow(map, VPS, MAC), level: "admin" as const },
    };
    const ownRole = {
      _tag: "putMachine" as const,
      machine: { ...machine(MAC), mapRole: "edit" as const },
    };
    expect(raisesOwnAccess(map, MAC, [raiseOwn])).toBe(true);
    expect(raisesOwnAccess(map, MAC, [raiseOther])).toBe(false);
    expect(raisesOwnAccess(map, MAC, [ownRole])).toBe(true);
  });

  it("always proposes a self-escalation, even with the edit role", () => {
    const raise = { _tag: "setArrow" as const, arrow: { ...base, level: "admin" as const } };
    const lower = { _tag: "setArrow" as const, arrow: findArrow(threeMachines(), VPS, MAC) };
    expect(decideAgentWrite(withRole("edit"), MAC, [raise])).toEqual({
      _tag: "propose",
      reason: "self-escalation",
    });
    expect(decideAgentWrite(withRole("edit"), MAC, [lower])).toEqual({ _tag: "apply" });
    expect(decideAgentWrite(withRole("propose"), MAC, [lower])).toEqual({
      _tag: "propose",
      reason: "map-role",
    });
  });
});

describe("gateTool (MM-802)", () => {
  it("checks the map role of the calling machine", () => {
    expect(gateTool(withRole("none"), MAC, "machines_read")._tag).toBe("refuse");
    expect(gateTool(withRole("read"), MAC, "machines_read")._tag).toBe("allow");
    expect(gateTool(withRole("read"), MAC, "machines_resources")._tag).toBe("allow");
    expect(gateTool(withRole("read"), MAC, "machines_set_access")._tag).toBe("refuse");
    expect(gateTool(withRole("propose"), MAC, "machines_set_access")._tag).toBe("allow");
    expect(gateTool(withRole("propose"), MAC, "machines_command")._tag).toBe("refuse");
    expect(gateTool(withRole("edit"), MAC, "machines_command")._tag).toBe("allow");
  });
});

describe("raisesAnyAccess (MM-711)", () => {
  it("flags a raise on any arrow or map role, and lets lower changes through", () => {
    const map = withRole("edit");
    const raiseOther = {
      _tag: "setArrow" as const,
      arrow: { ...findArrow(map, VPS, MAC), level: "read" as const },
    };
    const raiseRole = {
      _tag: "putMachine" as const,
      machine: { ...machine(VPS), mapRole: "read" as const },
    };
    const lowerRole = {
      _tag: "putMachine" as const,
      machine: { ...machine(MAC), mapRole: "read" as const },
    };
    expect(raisesAnyAccess(map, [raiseOther])).toBe(true);
    expect(raisesAnyAccess(map, [raiseRole])).toBe(true);
    expect(raisesAnyAccess(map, [lowerRole])).toBe(false);
    expect(
      raisesAnyAccess(map, [
        {
          _tag: "setSetting",
          machineId: null,
          scope: "server",
          key: "theme",
          present: true,
          value: 1,
        },
      ]),
    ).toBe(false);
  });
});
