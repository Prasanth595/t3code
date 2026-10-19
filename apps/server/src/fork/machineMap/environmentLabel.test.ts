import { expect, it } from "vite-plus/test";

import { machineMapEnvironmentLabel } from "./environmentLabel.ts";

it("uses the map name only while enabled and joined", () => {
  const desired = { self: { name: "Mac" } };
  const label = (enabled: boolean, joined = true, name = "Mac") =>
    machineMapEnvironmentLabel("LT-HYPHCQL9RV", enabled, joined, {
      self: { ...desired.self, name },
    });
  expect(label(true)).toBe("Mac");
  expect(label(false)).toBe("LT-HYPHCQL9RV");
  expect(label(true, false)).toBe("LT-HYPHCQL9RV");
  expect(label(true, true, "  ")).toBe("LT-HYPHCQL9RV");
  expect(machineMapEnvironmentLabel("LT-HYPHCQL9RV", true, true, null)).toBe("LT-HYPHCQL9RV");
});
