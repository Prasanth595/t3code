import type { DeviceHostSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import { agentDeviceQuickStart, pngDimensions, resolveHostId } from "./handlers.ts";

const device = {
  hostId: "local",
  id: "ABCD-1234",
  platform: "ios" as const,
  name: "iPhone 17 Pro",
  version: "iOS 27.0",
  booted: true,
  physical: false,
};

const hosts = [
  { id: "local", label: "This machine" },
  { id: "0dc4f37b-5e0a-4f4c-9a51-0c6b8e8a1f2d", label: "oliverMac" },
  { id: "mini-1", label: "Mac mini" },
  { id: "mini-2", label: "Mac mini" },
].map((host): DeviceHostSummary => ({
  ...host,
  kind: host.id === "local" ? "local" : "ssh",
  platforms: [],
  hubInstalled: true,
  agentDeviceInstalled: true,
}));

describe("device tool helpers", () => {
  it.effect("resolves a host by exact id or case-insensitive label", () =>
    Effect.gen(function* () {
      const mac = "0dc4f37b-5e0a-4f4c-9a51-0c6b8e8a1f2d";
      expect(yield* resolveHostId(hosts, mac)).toBe(mac);
      expect(yield* resolveHostId(hosts, "olivermac")).toBe(mac);
    }),
  );

  it.effect("rejects an unknown or ambiguous host and lists the candidates", () =>
    Effect.gen(function* () {
      const unknown = yield* Effect.flip(resolveHostId(hosts, "studio"));
      expect(unknown.reason).toContain("This machine (local)");
      expect(unknown.reason).toContain("oliverMac (0dc4f37b-5e0a-4f4c-9a51-0c6b8e8a1f2d)");
      const ambiguous = yield* Effect.flip(resolveHostId(hosts, "mac mini"));
      expect(ambiguous.reason).toContain("Mac mini (mini-1), Mac mini (mini-2)");
      expect(ambiguous.reason).not.toContain("oliverMac");
    }),
  );

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

  it("reads PNG dimensions from the IHDR chunk", () => {
    const png = new Uint8Array(24);
    new DataView(png.buffer).setUint32(0, 0x89504e47);
    new DataView(png.buffer).setUint32(4, 0x0d0a1a0a);
    new DataView(png.buffer).setUint32(12, 0x49484452);
    new DataView(png.buffer).setUint32(16, 1179);
    new DataView(png.buffer).setUint32(20, 2556);
    expect(pngDimensions(png)).toEqual({ width: 1179, height: 2556 });
    expect(pngDimensions(new Uint8Array([1, 2, 3]))).toEqual({ width: 0, height: 0 });
  });
});
