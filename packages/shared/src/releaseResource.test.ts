import { describe, expect, it } from "@effect/vitest";

import { releaseResourceAttributes } from "./releaseResource.ts";

describe("releaseResourceAttributes", () => {
  it.each([
    ["dev", {}, "dev", "development"],
    ["stable", {}, "stable", "production"],
    ["nightly", {}, "nightly", "production"],
    ["preview", {}, "preview", "staging"],
    [
      "stable",
      { "deployment.environment.name": "staging", "t3code.release.channel": "" },
      "stable",
      "staging",
    ],
  ] as const)(
    "%s (operator: %o) reports %s in %s",
    (channel, operatorAttributes, expectedChannel, environment) => {
      expect(releaseResourceAttributes(channel, operatorAttributes)).toEqual({
        "t3code.release.channel": expectedChannel,
        "deployment.environment.name": environment,
      });
    },
  );
});
