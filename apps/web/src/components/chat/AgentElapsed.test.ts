import { expect, it } from "vite-plus/test";

import { elapsedWarningReached } from "./AgentElapsed";

it.each([
  [119_999, false],
  [120_000, true],
  [null, false],
] as const)(
  "warns at 120 seconds only after elapsed time reaches the threshold",
  (elapsedMs, warns) => {
    expect(elapsedWarningReached(elapsedMs, 120)).toBe(warns);
  },
);
