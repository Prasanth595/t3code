import { describe, expect, it } from "@effect/vitest";

import { releaseResourceAttributes } from "./releaseResource.ts";

describe("releaseResourceAttributes", () => {
  it.each([
    ["1.2.3-nightly.20261023.4", true, {}, undefined, "dev", "development"],
    ["1.2.3", false, {}, undefined, "stable", "production"],
    ["1.2.3-nightly.20261023.4", false, {}, undefined, "nightly", "production"],
    ["1.2.3-preview.20261023.1", false, {}, undefined, "preview", "staging"],
    ["1.2.3", false, {}, "preview", "preview", "staging"],
    [
      "1.2.3",
      false,
      { "deployment.environment.name": "staging", "t3code.release.channel": "" },
      undefined,
      "stable",
      "staging",
    ],
  ] as const)(
    "%s (development: %s, operator: %o, channel: %s) reports %s in %s",
    (version, isDevelopment, operatorAttributes, channel, expectedChannel, environment) => {
      expect(
        releaseResourceAttributes({ version, isDevelopment, operatorAttributes, channel }),
      ).toEqual({
        "t3code.release.channel": expectedChannel,
        "deployment.environment.name": environment,
      });
    },
  );
});
