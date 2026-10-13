import { describe, expect, it } from "vite-plus/test";

import { runtimeModeChoicesForSupportedModes } from "./thread-settings-options";

describe("runtimeModeChoicesForSupportedModes", () => {
  it("keeps controls usable when forward-compatible decoding removes every advertised mode", () => {
    expect(runtimeModeChoicesForSupportedModes([])).toHaveLength(4);
  });
});
