import { describe, expect, it } from "vite-plus/test";

import { resolveUserMessageIntentBadge } from "./userMessageIntentBadge";

describe("resolveUserMessageIntentBadge", () => {
  it.each(["steer", "promoted_queued_to_steer"] as const)(
    "distinguishes a queued %s from a consumed steer",
    (intent) => {
      expect(resolveUserMessageIntentBadge(intent, true)).toEqual({
        label: "Steer queued",
        accessibilityLabel: "Waiting for the provider to consume this message",
      });
      expect(resolveUserMessageIntentBadge(intent, false)?.label).toBe("Steer");
      expect(resolveUserMessageIntentBadge(intent)?.label).toBe("Steer");
    },
  );

  it.each(["turn_start", "queued_turn", undefined] as const)(
    "does not label a pending %s as a steer",
    (intent) => {
      expect(resolveUserMessageIntentBadge(intent, true)).toBeNull();
    },
  );
});
