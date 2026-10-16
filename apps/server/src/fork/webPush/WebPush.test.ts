import { describe, expect, it } from "@effect/vitest";

import { attentionTransition } from "./WebPush.ts";

describe("attentionTransition", () => {
  it("notifies when a thread starts to wait or a running thread ends", () => {
    expect(attentionTransition("running", "waiting_for_approval")).toBe("waiting_for_approval");
    expect(attentionTransition("running", "waiting_for_input")).toBe("waiting_for_input");
    expect(attentionTransition("running", "completed")).toBe("completed");
    expect(attentionTransition("waiting_for_input", "failed")).toBe("failed");
  });

  it("stays quiet for a thread first seen since the start, and for a new session", () => {
    expect(attentionTransition(undefined, "waiting_for_input")).toBeNull();
    expect(attentionTransition(undefined, "completed")).toBeNull();
    // A new session reads `completed` for an instant before its first turn.
    expect(attentionTransition(null, "completed")).toBeNull();
    expect(attentionTransition("completed", "completed")).toBeNull();
  });
});
