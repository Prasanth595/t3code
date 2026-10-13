import { describe, expect, it } from "vite-plus/test";

import { describeUserAgent } from "./device.ts";

describe("describeUserAgent", () => {
  it("names common devices and browsers", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      ),
    ).toEqual({ device: "Mac", browser: "Chrome" });
    expect(
      describeUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
      ),
    ).toEqual({ device: "iPhone", browser: "Safari" });
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      ),
    ).toEqual({ device: "Windows", browser: "Edge" });
    expect(describeUserAgent(null)).toEqual({
      device: "Unknown device",
      browser: "Unknown browser",
    });
  });
});
