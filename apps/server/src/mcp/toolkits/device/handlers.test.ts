import { describe, expect, it } from "vite-plus/test";

import { agentDeviceQuickStart, agentDeviceTargetArgs } from "./handlers.ts";

const device = {
  hostId: "local",
  id: "ABCD-1234",
  platform: "ios" as const,
  name: "iPhone 17 Pro",
  version: "iOS 27.0",
  booted: true,
  physical: false,
};

describe("device tool helpers", () => {
  it("pins agent-device commands to the device by platform-specific flag", () => {
    expect(agentDeviceTargetArgs(device)).toEqual(["--platform", "ios", "--udid", "ABCD-1234"]);
    expect(agentDeviceTargetArgs({ ...device, platform: "android", id: "emulator-5554" })).toEqual([
      "--platform",
      "android",
      "--serial",
      "emulator-5554",
    ]);
  });

  it("writes the quick start around the pinned target", () => {
    const text = agentDeviceQuickStart(device);
    expect(text).toContain("agent-device snapshot -i --platform ios --udid ABCD-1234");
    expect(text).toContain("iPhone 17 Pro (iOS 27.0)");
    expect(text).toContain("XCTest runner");
  });

  it("uses the absolute launcher in every quick-start command", () => {
    const text = agentDeviceQuickStart(
      device,
      ["--session", "thread-1", "--config", "/tmp/host.json"],
      "/tmp/t3 tools/agent-device",
    );
    expect(text).toContain(
      "'/tmp/t3 tools/agent-device' snapshot -i --session thread-1 --config /tmp/host.json",
    );
    expect(text).not.toContain("  agent-device ");
    expect(text).not.toContain("is on PATH");
  });
});
