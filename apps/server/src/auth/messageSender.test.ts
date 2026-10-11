import { describe, expect, it } from "vite-plus/test";

import { messageSenderFromConnection } from "./messageSender.ts";

const client = { label: "T3 Code Mobile", deviceType: "mobile", os: "iOS" } as const;

describe("messageSenderFromConnection", () => {
  it("treats a direct loopback peer as this machine", () => {
    for (const remoteAddress of ["127.0.0.1", "::1"]) {
      expect(
        messageSenderFromConnection({ client, surface: "mobile", remoteAddress, proxied: false }),
      ).toEqual({
        label: "T3 Code Mobile",
        deviceType: "mobile",
        os: "iOS",
        surface: "mobile",
        sameMachine: true,
      });
    }
  });

  it("does not trust loopback behind a proxy or a remote peer", () => {
    expect(
      messageSenderFromConnection({ client, remoteAddress: "127.0.0.1", proxied: true })
        .sameMachine,
    ).toBe(false);
    expect(
      messageSenderFromConnection({ client, remoteAddress: "100.82.1.2", proxied: false })
        .sameMachine,
    ).toBe(false);
    expect(
      messageSenderFromConnection({ client, remoteAddress: undefined, proxied: false }).sameMachine,
    ).toBe(false);
  });

  it("omits absent client details", () => {
    expect(
      messageSenderFromConnection({
        client: { deviceType: "unknown" },
        remoteAddress: "10.0.0.2",
        proxied: false,
      }),
    ).toEqual({ deviceType: "unknown", sameMachine: false });
  });
});
