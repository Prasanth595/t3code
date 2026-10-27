import {
  OnePasswordAccount,
  SecretProviderId,
  SecretProviderLabel,
  type SecretProviderConfig,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** One line naming the kind and where it reads from, for rows and pickers. */
export function secretProviderSummary(config: SecretProviderConfig): string {
  return `1Password · ${config.account}`;
}

/** Stable and readable in settings.json, so re-adding a provider under the same name restores its variables. */
export function secretProviderIdFromName(name: string): SecretProviderId | null {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length === 0 ? null : SecretProviderId.make(slug);
}

export interface SecretProviderDraft {
  readonly name: string;
  readonly account: string;
}

export const EMPTY_SECRET_PROVIDER_DRAFT: SecretProviderDraft = { name: "", account: "" };

export function secretProviderDraftFromConfig(config: SecretProviderConfig): SecretProviderDraft {
  return { name: config.label, account: config.account };
}

export type SecretProviderTarget =
  | { readonly mode: "add" }
  | { readonly mode: "edit"; readonly id: SecretProviderId };

function decodeField<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: string,
  emptyMessage: string,
): Result.Result<S["Type"], string> {
  if (value.trim().length === 0) return Result.fail(emptyMessage);
  const decoded = Schema.decodeResult(schema)(value.trim());
  return Result.isFailure(decoded)
    ? Result.fail(decoded.failure.message)
    : Result.succeed(decoded.success);
}

export type SecretProviderDraftField = "name" | "account";

export type SecretProviderDraftIssues = Partial<Readonly<Record<SecretProviderDraftField, string>>>;

/** The settings entry a draft adds or replaces, or every field that blocks it, one message each. */
export function secretProviderFromDraft(
  draft: SecretProviderDraft,
  existingIds: ReadonlySet<string>,
  target: SecretProviderTarget,
): Result.Result<
  { readonly id: SecretProviderId; readonly config: SecretProviderConfig },
  SecretProviderDraftIssues
> {
  const issues: { -readonly [Field in SecretProviderDraftField]?: string } = {};

  const label = decodeField(SecretProviderLabel, draft.name, "Enter a name.");
  const id =
    target.mode === "edit"
      ? target.id
      : Result.isSuccess(label)
        ? secretProviderIdFromName(label.success)
        : null;
  if (Result.isFailure(label)) {
    issues.name = label.failure;
  } else if (id === null) {
    issues.name = "The name needs at least one letter or digit.";
  } else if (target.mode === "add" && existingIds.has(id)) {
    issues.name = `A secret provider named ${label.success} exists.`;
  }

  const account = decodeField(OnePasswordAccount, draft.account, "Enter the 1Password account.");
  if (Result.isFailure(account)) issues.account = account.failure;

  if (
    issues.name !== undefined ||
    Result.isFailure(label) ||
    id === null ||
    Result.isFailure(account)
  ) {
    return Result.fail(issues);
  }
  return Result.succeed({
    id,
    config: { kind: "1password", label: label.success, account: account.success },
  });
}
