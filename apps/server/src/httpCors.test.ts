import { describe, expect, it } from "vite-plus/test";

import { DESKTOP_RENDERER_ORIGINS } from "./httpCors.ts";

describe("DESKTOP_RENDERER_ORIGINS", () => {
  it("trusts the fork renderer and not upstream's", () => {
    expect([...DESKTOP_RENDERER_ORIGINS]).toEqual([
      "t3code-factory://app",
      "t3code-factory-dev://app",
    ]);
  });
});
