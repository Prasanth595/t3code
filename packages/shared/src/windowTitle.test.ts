import { describe, expect, it } from "@effect/vitest";

import { formatWindowTitle, resolveDesktopWindowTitle } from "./windowTitle.ts";

describe("formatWindowTitle", () => {
  it("puts the thread and project before the app name", () => {
    expect(
      formatWindowTitle({ appName: "T3 Code (Alpha)", context: ["Fix login", "acme-api"] }),
    ).toBe("Fix login · acme-api · T3 Code (Alpha)");
  });

  it("skips missing and blank parts", () => {
    expect(formatWindowTitle({ appName: "T3 Code", context: [null, "  ", undefined] })).toBe(
      "T3 Code",
    );
    expect(formatWindowTitle({ appName: "T3 Code", context: [" Fix login ", null] })).toBe(
      "Fix login · T3 Code",
    );
  });
});

describe("resolveDesktopWindowTitle", () => {
  it("keeps the page context and swaps in the desktop app name", () => {
    expect(
      resolveDesktopWindowTitle("Fix login · acme-api · T3 Code (Nightly)", "T3 Code (Alpha)"),
    ).toBe("Fix login · acme-api · T3 Code (Alpha)");
  });

  it("keeps separators inside a thread title", () => {
    expect(resolveDesktopWindowTitle("a · b · acme-api · T3 Code", "T3 Code (Alpha)")).toBe(
      "a · b · acme-api · T3 Code (Alpha)",
    );
  });

  it("uses the app name when the page has no context", () => {
    expect(resolveDesktopWindowTitle("T3 Code (Beta)", "T3 Code (Alpha)")).toBe("T3 Code (Alpha)");
    expect(resolveDesktopWindowTitle("", "T3 Code (Alpha)")).toBe("T3 Code (Alpha)");
  });
});
