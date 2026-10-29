import { describe, expect, it } from "vite-plus/test";

import { toIntlLocale } from "./systemLocale.ts";

describe("toIntlLocale", () => {
  it.each([
    ["en_GB", "en-GB"],
    ["en_US@rg=nlzzzz", "en-NL"],
    ["en-US@rg=nlzzzz", "en-NL"],
    ["zh_Hans_CN@calendar=chinese;rg=twzzzz", "zh-Hans-TW"],
  ])("%s becomes %s", (icuLocale, expected) => {
    expect(toIntlLocale(icuLocale)).toBe(expected);
  });

  it("follows the region override's clock", () => {
    const formatter = new Intl.DateTimeFormat(toIntlLocale("en_US@rg=nlzzzz"), { hour: "numeric" });
    expect(formatter.resolvedOptions().hourCycle).toBe("h23");
  });
});
