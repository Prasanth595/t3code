import { OnePasswordAccount, SecretProviderId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_SECRET_PROVIDER_DRAFT,
  secretProviderDraftFromConfig,
  secretProviderFromDraft,
  secretProviderIdFromName,
  type SecretProviderTarget,
} from "./SecretProviderDialog.logic";

const NO_IDS: ReadonlySet<string> = new Set();
const ADD: SecretProviderTarget = { mode: "add" };

describe("secretProviderIdFromName", () => {
  it("slugs the name so the id stays readable in settings.json", () => {
    expect(secretProviderIdFromName("  Work 1Password!  ")).toBe("work-1password");
  });

  it("has no id for a name without letters or digits", () => {
    expect(secretProviderIdFromName(" -- ")).toBeNull();
  });
});

describe("secretProviderFromDraft", () => {
  it("builds a 1Password provider", () => {
    const result = secretProviderFromDraft(
      { name: "Personal", account: "my.1password.com" },
      NO_IDS,
      ADD,
    );
    expect(result).toEqual(
      Result.succeed({
        id: "personal",
        config: { kind: "1password", label: "Personal", account: "my.1password.com" },
      }),
    );
  });

  it("rejects an empty name and a name that is already taken", () => {
    expect(
      secretProviderFromDraft({ ...EMPTY_SECRET_PROVIDER_DRAFT, name: "  " }, NO_IDS, ADD),
    ).toEqual(Result.fail({ name: "Enter a name.", account: "Enter the 1Password account." }));
    expect(
      secretProviderFromDraft({ name: "Work Vault", account: "my" }, new Set(["work-vault"]), ADD),
    ).toEqual(Result.fail({ name: "A secret provider named Work Vault exists." }));
  });

  it("rejects a name without letters or digits", () => {
    expect(secretProviderFromDraft({ name: "--", account: "my" }, NO_IDS, ADD)).toEqual(
      Result.fail({ name: "The name needs at least one letter or digit." }),
    );
  });

  it("requires a 1Password account", () => {
    expect(
      secretProviderFromDraft({ ...EMPTY_SECRET_PROVIDER_DRAFT, name: "Ops" }, NO_IDS, ADD),
    ).toEqual(Result.fail({ account: "Enter the 1Password account." }));
  });

  it("rejects an account the op CLI could read as a flag", () => {
    const result = secretProviderFromDraft({ name: "Ops", account: "--help" }, NO_IDS, ADD);
    expect(Result.isFailure(result) && result.failure.account).toBeTruthy();
  });

  it("keeps the id and accepts its own name when editing", () => {
    const id = SecretProviderId.make("personal");
    const result = secretProviderFromDraft(
      { name: "Personal", account: "team.1password.com" },
      new Set(["personal"]),
      { mode: "edit", id },
    );
    expect(Result.isSuccess(result) && result.success.id).toBe(id);
  });
});

describe("secretProviderDraftFromConfig", () => {
  it("fills a 1Password draft", () => {
    expect(
      secretProviderDraftFromConfig({
        kind: "1password",
        label: "Personal",
        account: OnePasswordAccount.make("my.1password.com"),
      }),
    ).toEqual({ name: "Personal", account: "my.1password.com" });
  });
});
