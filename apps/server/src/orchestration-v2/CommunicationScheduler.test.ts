import { describe, expect, it } from "vite-plus/test";

import { hasQueuedHumanInput } from "./CommunicationScheduler.ts";

describe("communication scheduler", () => {
  it("defers an automatic steer when a verified human request is queued", () => {
    const projection = {
      messages: [
        {
          id: "message:human",
          communication: {
            classification: "verified",
            route: { port: "user.in" },
            producer: { kind: "human" },
          },
        },
      ],
      runs: [{ status: "queued", userMessageId: "message:human" }],
    } as never;
    expect(hasQueuedHumanInput(projection)).toBe(true);
  });

  it("does not treat an agent-authored or completed item as pending human input", () => {
    const projection = {
      messages: [
        {
          id: "message:agent",
          communication: {
            classification: "verified",
            route: { port: "user.in" },
            producer: { kind: "agent" },
          },
        },
      ],
      runs: [{ status: "queued", userMessageId: "message:agent" }],
    } as never;
    expect(hasQueuedHumanInput(projection)).toBe(false);
  });
});
