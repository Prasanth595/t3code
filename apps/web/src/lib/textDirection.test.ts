import { describe, expect, it } from "vite-plus/test";

import { blockDirection, resolveTextDirection } from "./textDirection";

describe("resolveTextDirection", () => {
  it("follows the dominant script, not the first letter", () => {
    expect(resolveTextDirection("Device hub: מאפשר לנהל מכשירים מכל מקום.")).toBe("rtl");
    expect(resolveTextDirection("git status يعرض حالة المستودع الحالية.")).toBe("rtl");
    expect(resolveTextDirection("Use the הגדרות panel to change the theme.")).toBe("ltr");
  });

  it("keeps plain left-to-right and right-to-left text as they are", () => {
    expect(resolveTextDirection("Hello world")).toBe("ltr");
    expect(resolveTextDirection("مرحبا بالعالم")).toBe("rtl");
    expect(resolveTextDirection("שלום עולם")).toBe("rtl");
  });

  it("lets an explicit directional mark decide", () => {
    expect(resolveTextDirection("‏Hello world")).toBe("rtl");
    expect(resolveTextDirection("؜Hello world")).toBe("rtl");
    expect(resolveTextDirection("‎مرحبا بالعالم")).toBe("ltr");
  });

  it("has no direction for text without letters", () => {
    expect(resolveTextDirection("123 + 456 = 579 🎉")).toBeNull();
    expect(blockDirection("— 42 —")).toBe("auto");
  });
});
