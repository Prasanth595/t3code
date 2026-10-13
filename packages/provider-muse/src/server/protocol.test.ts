import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { MuseSubscriptionUsage, museApprovalChoices } from "./protocol.ts";

// Muse 1.4.3 shell approvals offer only `abort`; the muse_permission replay covers that case.
describe("Muse approval choices", () => {
  it("keeps denied and abort separate when Muse offers both", () => {
    const choices = museApprovalChoices({
      availableChoices: [
        { choiceId: "deny", label: "Deny", decision: "denied", scope: "once" },
        { choiceId: "abort", label: "Stop", decision: "abort", scope: "once" },
      ],
    });
    expect(choices.get("decline")?.choiceId).toBe("deny");
    expect(choices.get("cancel")?.choiceId).toBe("abort");
  });
});

describe("Muse subscription usage", () => {
  const report = {
    observedAtMs: 1_000,
    tier: "meta-subscription",
    window: { usedPercent: 3, resetsAtMs: 2_000, windowDurationMins: 300 },
    weekly: { usedPercent: 46, resetsAtMs: 3_000 },
  };
  const decode = Schema.decodeUnknownResult(MuseSubscriptionUsage);

  it("decodes a report, including over-quota percentages", () => {
    expect(decode({ ...report, weekly: { ...report.weekly, usedPercent: 130 } })._tag).toBe(
      "Success",
    );
  });

  it("rejects a fractional window duration at the boundary", () => {
    expect(
      decode({ ...report, window: { ...report.window, windowDurationMins: 300.5 } })._tag,
    ).toBe("Failure");
  });

  it("rejects timestamps a Date cannot hold", () => {
    expect(decode({ ...report, observedAtMs: Number.MAX_VALUE })._tag).toBe("Failure");
    expect(decode({ ...report, window: { ...report.window, resetsAtMs: 0 } })._tag).toBe("Failure");
  });
});
