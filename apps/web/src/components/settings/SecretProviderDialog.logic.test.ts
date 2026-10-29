import { SecretProviderId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { secretProviderFromDraft } from "./SecretProviderDialog.logic";

describe("secretProviderFromDraft", () => {
  it("adds a provider keyed by its name and reports every field that blocks it", () => {
    expect(
      secretProviderFromDraft(
        { name: "  Work 1Password!  ", account: "my.1password.com" },
        new Set(),
        { mode: "add" },
      ),
    ).toEqual(
      Result.succeed({
        id: "work-1password",
        config: {
          kind: "1password",
          label: "Work 1Password!",
          config: { account: "my.1password.com" },
        },
      }),
    );

    const blocked = secretProviderFromDraft(
      { name: "Work 1Password", account: "--help" },
      new Set(["work-1password"]),
      { mode: "add" },
    );
    expect(Result.isFailure(blocked) && Object.keys(blocked.failure).toSorted()).toEqual([
      "account",
      "name",
    ]);
  });

  it("rejects a name that cannot start a slug", () => {
    const result = secretProviderFromDraft(
      { name: "1Password", account: "my.1password.com" },
      new Set(),
      { mode: "add" },
    );
    expect(Result.isFailure(result) && result.failure).toEqual({
      name: "The name needs to start with a letter.",
    });
  });

  it("keeps the id when an edit renames the provider", () => {
    const id = SecretProviderId.make("personal");
    const result = secretProviderFromDraft(
      { name: "Personal (team)", account: "team.1password.com" },
      new Set(["personal"]),
      { mode: "edit", id },
    );
    expect(Result.isSuccess(result) && result.success).toEqual({
      id,
      config: {
        kind: "1password",
        label: "Personal (team)",
        config: { account: "team.1password.com" },
      },
    });
  });
});
