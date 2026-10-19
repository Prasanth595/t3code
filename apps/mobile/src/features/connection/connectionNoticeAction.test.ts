import { PAIRING_REVOKED_MESSAGE } from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "@effect/vitest";

import { connectionNoticeAction } from "./connectionNoticeAction";

describe("connectionNoticeAction", () => {
  it("offers Pair again for a refused pairing and Retry now otherwise", () => {
    expect(connectionNoticeAction({ phase: "error", error: PAIRING_REVOKED_MESSAGE })).toBe(
      "pair-again",
    );
    expect(
      connectionNoticeAction({
        phase: "error",
        error: "The environment endpoint could not be found.",
      }),
    ).toBe("retry");
    expect(connectionNoticeAction({ phase: "offline", error: null })).toBe(null);
  });
});
