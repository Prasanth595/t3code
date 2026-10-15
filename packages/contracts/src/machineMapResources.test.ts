import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { MachineToPortal, PortalToMachine } from "./machineMap.ts";
import {
  MachineResourcesMessage,
  PortalResourcesRequest,
  type ResourceSample,
} from "./machineMapResources.ts";

const sample: ResourceSample = {
  at: "2026-10-13T08:00:00.000Z",
  cpuPercent: 10,
  cpuBusyPercent: 8,
  cpuStealPercent: null,
  cpuPressurePercent: 2,
  cpuCount: 4,
  load: [0.5, 0.4, 0.3],
  memoryUsedBytes: 1,
  memoryTotalBytes: 2,
  swapUsedBytes: 0,
  swapTotalBytes: 0,
  swapBytesPerSecond: 0,
  diskUsedBytes: 1,
  diskTotalBytes: 2,
  netInBytesPerSecond: 3,
  netOutBytesPerSecond: 4,
  t3: { cpuPercent: 1, memoryBytes: 5 },
  agents: { count: 1, cpuPercent: 2, memoryBytes: 3 },
  topCpu: [{ name: "node", cpuPercent: 2, memoryBytes: 3 }],
  topMemory: [{ name: "node", cpuPercent: null, memoryBytes: 3 }],
  battery: { percent: 54, state: "charging", minutesLeft: 62 },
};

describe("resource messages next to the base protocol (MM-1502)", () => {
  it("an older portal and an older server fail to decode them, so they ignore them", () => {
    expect(Schema.decodeUnknownOption(MachineToPortal)({ _tag: "resources", sample })._tag).toBe(
      "None",
    );
    expect(Schema.decodeUnknownOption(PortalToMachine)({ _tag: "sampleResources" })._tag).toBe(
      "None",
    );
  });

  it("the new unions decode both the old and the new messages", () => {
    const fromMachine = Schema.decodeUnknownSync(
      Schema.Union([MachineToPortal, MachineResourcesMessage]),
    );
    const fromPortal = Schema.decodeUnknownSync(
      Schema.Union([PortalToMachine, PortalResourcesRequest]),
    );
    expect(fromMachine({ _tag: "resources", sample })).toEqual({ _tag: "resources", sample });
    expect(fromMachine({ _tag: "applied", revision: 3 })).toEqual({ _tag: "applied", revision: 3 });
    expect(fromPortal({ _tag: "sampleResources" })).toEqual({ _tag: "sampleResources" });
    // A sample of an older server has no CPU pressure fields. It still decodes.
    const { cpuBusyPercent, cpuStealPercent, cpuPressurePercent, ...older } = sample;
    expect(fromMachine({ _tag: "resources", sample: older })).toMatchObject({
      sample: { cpuBusyPercent: null, cpuPressurePercent: null },
    });
  });

  it("refuses a top list longer than five", () => {
    const decode = Schema.decodeUnknownOption(MachineResourcesMessage);
    const six = Array.from({ length: 6 }, () => ({ name: "x", cpuPercent: 1, memoryBytes: 1 }));
    expect(decode({ _tag: "resources", sample: { ...sample, topCpu: six } })._tag).toBe("None");
  });
});
