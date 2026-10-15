import { describe, expect, it } from "@effect/vitest";

import { deriveThreadTitleSeed } from "./threadTitle.ts";

describe("deriveThreadTitleSeed", () => {
  const image = "![pasted-image.png](t3-context://v1/image/aadd9cc6-1234-5678-9012-abcdef123456)";

  it.each([{ attachments: [] }, { attachments: [{ name: "pasted-image.png" }] }])(
    "uses a readable image-only title with attachments $attachments",
    ({ attachments }) => {
      expect(deriveThreadTitleSeed({ text: image, attachments })).toBe("Image: pasted-image.png");
    },
  );

  it.each([`${image}\nFix the spacing`, `Fix ${image} the spacing`])(
    "prefers prose around image references: %s",
    (text) => {
      expect(deriveThreadTitleSeed({ text, attachments: [] })).toBe("Fix the spacing");
    },
  );

  it("uses the first image label for several images", () => {
    expect(
      deriveThreadTitleSeed({
        text: `${image}\n![other.png](t3-context://v1/image/other)`,
        attachments: [],
      }),
    ).toBe("Image: pasted-image.png");
  });

  it("keeps context labels without exposing their internal URLs", () => {
    expect(
      deriveThreadTitleSeed({
        text: `${image} Fix [src/app.ts](t3-context://v1/mention/source) using [Build output](t3-context://v1/terminal/build)`,
        attachments: [],
      }),
    ).toBe("Fix src/app.ts using Build output");
  });

  it("prefers normalized message text", () => {
    expect(
      deriveThreadTitleSeed({
        text: "  Investigate\n  login   failures  ",
        attachments: [{ name: "login-error.png" }],
        fallbackLabels: ["Terminal 1"],
      }),
    ).toBe("Investigate login failures");
  });

  it("uses the first attachment name when text is empty", () => {
    expect(
      deriveThreadTitleSeed({
        text: " \n ",
        attachments: [{ name: "login-error.png" }, { name: "other.png" }],
      }),
    ).toBe("Image: login-error.png");
  });

  it("uses the first non-empty fallback label after text and attachments", () => {
    expect(
      deriveThreadTitleSeed({
        text: "",
        attachments: [],
        fallbackLabels: [null, "  ", "Terminal 1"],
      }),
    ).toBe("Terminal 1");
  });

  it("falls back to New thread", () => {
    expect(deriveThreadTitleSeed({ text: "", attachments: [] })).toBe("New thread");
  });

  it("applies the shared title truncation", () => {
    expect(
      deriveThreadTitleSeed({
        text: "x".repeat(60),
        attachments: [],
      }),
    ).toBe(`${"x".repeat(50)}...`);
  });
});
