import { describe, expect, it } from "vite-plus/test";

import { blockDirection, hastBlockDirection, resolveTextDirection } from "./textDirection";

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

it("does not count Arabic digits, punctuation or combining marks as RTL letters", () => {
  expect(resolveTextDirection("١٢٣٤٥٦٧٨٩٠ — Hi")).toBe("ltr");
  expect(resolveTextDirection("١٢٣٤٥٦٧٨٩٠ ، ؛ ؟")).toBeNull();
  expect(resolveTextDirection("\u064e\u0650\u0651 Hi")).toBe("ltr");
  expect(resolveTextDirection("abc אבג")).toBe("ltr");
});

it("excludes inline code and nested lists when deciding a parent block direction", () => {
  const text = (value: string) => ({ type: "text", value });
  const element = (tagName: string, ...children: unknown[]) => ({
    type: "element",
    tagName,
    children,
  });
  expect(
    hastBlockDirection(
      element(
        "p",
        element("strong", text("Device hub")),
        text(": מאפשר לנהל את כל המכשירים ממקום אחד."),
      ),
    ),
  ).toBe("rtl");
  expect(
    hastBlockDirection(
      element(
        "li",
        text("שלום"),
        element("code", text("const someLongIdentifierName = value")),
        element("ul", element("li", text("A much longer English child list item"))),
      ),
    ),
  ).toBe("rtl");
  expect(hastBlockDirection(element("p", element("code", text("مرحبا"))))).toBe("auto");
});
