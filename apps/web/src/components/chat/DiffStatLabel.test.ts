import { describe, expect, it } from "vite-plus/test";

import { formatCompactDiffCount } from "./DiffStatLabel";

describe("formatCompactDiffCount", () => {
  it("promotes counts when rounding reaches the next suffix", () => {
    expect([
      999_499,
      999_500,
      999_999,
      1_000_000,
      999_499_999,
      999_500_000,
      999_999_999,
      1_000_000_000,
    ].map(formatCompactDiffCount)).toEqual(["999k", "1m", "1m", "1m", "999m", "1b", "1b", "1b"]);
  });
});
