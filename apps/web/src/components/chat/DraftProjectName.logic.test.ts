import { describe, expect, it } from "vite-plus/test";

import { truncateProjectName } from "./DraftProjectName.logic";

const measure = (text: string) => Array.from(text).length;

describe("truncateProjectName", () => {
  it("keeps distinguishing suffixes in one string without adding whitespace", () => {
    expect(truncateProjectName("ExampleCompany-CustomerPortal-App", 19, measure)).toBe(
      "ExampleCo…ortal-App",
    );
    expect(truncateProjectName("ExampleCompany-CustomerPortal-Env", 19, measure)).toBe(
      "ExampleCo…ortal-Env",
    );
  });

  it("leaves names that fit unchanged", () => {
    expect(truncateProjectName("ShortRepo", 9, measure)).toBe("ShortRepo");
  });

  it("keeps a name the measurer reports slightly wider than its container", () => {
    const pixels = (text: string) => Array.from(text).length * 10;
    const overMeasured = (text: string) => pixels(text) + 0.6;
    expect(truncateProjectName("mozart_v2", pixels("mozart_v2"), overMeasured)).toBe("mozart_v2");
  });

  it("still truncates a name that is clearly wider than its container", () => {
    const pixels = (text: string) => Array.from(text).length * 10;
    expect(truncateProjectName("mozart_v2", 80, pixels)).toBe("moz…t_v2");
    expect(truncateProjectName("mozart_v2", pixels("mozart_v2") - 2, pixels)).toBe("moz…t_v2");
  });

  it("fits proportional character widths", () => {
    const proportional = (text: string) =>
      Array.from(text).reduce((width, character) => width + (character === "W" ? 3 : 1), 0);
    expect(truncateProjectName("WWWW-project-App", 12, proportional)).toBe("WW…App");
  });

  it("keeps combining marks and emoji sequences intact", () => {
    const value = "e\u0301👩‍💻-customer-portal-App";
    const result = truncateProjectName(value, 18, measure);
    expect(result.startsWith("e\u0301👩‍💻")).toBe(true);
    expect(result.endsWith("App")).toBe(true);
    expect(measure(result)).toBeLessThanOrEqual(18);
  });

  it("handles space for only the ellipsis or no text", () => {
    expect(truncateProjectName("ExampleCompany", 1, measure)).toBe("…");
    expect(truncateProjectName("ExampleCompany", 0, measure)).toBe("");
  });
});
