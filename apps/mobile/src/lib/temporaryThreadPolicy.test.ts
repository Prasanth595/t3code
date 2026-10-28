import { describe, expect, it } from "vite-plus/test";
import { temporaryThreadSendBlockReason } from "./temporaryThreadPolicy";

const model = { instanceId: "provider", model: "model" };

describe("temporary provider admission", () => {
  it("requires both the destination server and the chosen provider to support temporary threads", () => {
    expect(temporaryThreadSendBlockReason(undefined, model)).toContain("server");
    expect(
      temporaryThreadSendBlockReason(
        {
          environment: { capabilities: { temporaryThreads: true } },
          providers: [{ instanceId: "provider" }],
        },
        model,
      ),
    ).toContain("provider");
    expect(
      temporaryThreadSendBlockReason(
        {
          environment: { capabilities: {} },
          providers: [{ instanceId: "provider", temporaryThreads: true }],
        },
        model,
      ),
    ).toContain("server");
    expect(
      temporaryThreadSendBlockReason(
        {
          environment: { capabilities: { temporaryThreads: true } },
          providers: [{ instanceId: "provider", temporaryThreads: true }],
        },
        model,
      ),
    ).toBeNull();
    expect(
      temporaryThreadSendBlockReason(
        {
          environment: { capabilities: { temporaryThreads: true } },
          providers: [{ instanceId: "other", temporaryThreads: true }],
        },
        model,
      ),
    ).toContain("provider");
  });
});
