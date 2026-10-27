import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { SecretProviderConfig } from "./secretProvider.ts";

const decodeConfig = Schema.decodeUnknownSync(SecretProviderConfig);

describe("SecretProviderConfig", () => {
  const onePassword = (account: string) => ({ kind: "1password", label: "Personal", account });

  it.each(["my", "my.1password.com", "team-acme.1password.eu", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"])(
    "decodes a 1Password provider for the account %s",
    (account) => {
      expect(decodeConfig(onePassword(account))).toEqual(onePassword(account));
    },
  );

  it.each([
    ["empty", ""],
    ["a space", "my account"],
    ["a CLI flag", "--help"],
    ["surrounding whitespace", " my "],
  ])("rejects a 1Password account with %s", (_, account) => {
    expect(() => decodeConfig(onePassword(account))).toThrow();
  });

  it("rejects a 1Password provider without an account", () => {
    expect(() => decodeConfig({ kind: "1password", label: "Personal" })).toThrow();
  });
});
