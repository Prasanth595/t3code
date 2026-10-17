import { describe, expect, it } from "vite-plus/test";

import { parseThreadAddress } from "./threadAddress.ts";
import { linkThreadMarkers } from "./threadMarkers.ts";

describe("parseThreadAddress", () => {
  it("reads web and app links, percent-decoded, with an optional message", () => {
    expect(parseThreadAddress("https://t3.example.com/env-1/mcp%3Aabc-1/")).toEqual({
      environmentId: "env-1",
      threadId: "mcp:abc-1",
    });
    expect(parseThreadAddress("t3code://threads/env-1/thread-1?message=msg-1")).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
      messageId: "msg-1",
    });
  });

  it("leaves other addresses alone", () => {
    expect(parseThreadAddress("https://t3.example.com/env-1/thread-1?prompt=hi")).toBeNull();
    expect(parseThreadAddress("t3code://threads/env-1/thread-1?prompt=hi")).toBeNull();
    expect(parseThreadAddress("t3code://new?prompt=hi")).toBeNull();
    expect(parseThreadAddress("https://t3.example.com/settings")).toBeNull();
    expect(parseThreadAddress("https://github.com/owner/repo/pull/1")).toBeNull();
    expect(parseThreadAddress("t3-thread://v1/thread-1")).toBeNull();
  });
});

describe("linkThreadMarkers", () => {
  it("links markers of attached threads outside code and keeps the rest", () => {
    const targets = new Map([["ctx_1", { environmentId: "env-1", threadId: "thread-1" }]] as const);
    expect(
      linkThreadMarkers(
        "See [Thread: Fix; ref=ctx_1], `[Thread: Fix; ref=ctx_1]`, [Thread: Old; ref=ctx_9].",
        targets as never,
      ),
    ).toBe(
      "See [Fix](t3code://threads/env-1/thread-1), `[Thread: Fix; ref=ctx_1]`, [Thread: Old; ref=ctx_9].",
    );
  });
});
