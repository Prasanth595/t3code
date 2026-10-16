import { describe, expect, it } from "vite-plus/test";

import { parseThreadAddress } from "./threadAddress.ts";

describe("parseThreadAddress", () => {
  it("reads the environment and thread from the path, percent-decoded", () => {
    expect(parseThreadAddress("https://t3.example.com/env-1/mcp%3Aabc-1/")).toEqual({
      environmentId: "env-1",
      threadId: "mcp:abc-1",
    });
  });

  it("leaves other addresses alone", () => {
    expect(parseThreadAddress("https://t3.example.com/env-1/thread-1?prompt=hi")).toBeNull();
    expect(parseThreadAddress("https://t3.example.com/settings")).toBeNull();
    expect(parseThreadAddress("https://github.com/owner/repo/pull/1")).toBeNull();
    expect(parseThreadAddress("t3-thread://v1/thread-1")).toBeNull();
  });
});
