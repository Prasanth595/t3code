import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OnePasswordAccount } from "./onePassword.ts";

const SECRET_PROVIDER_LABEL_MAX_CHARS = 64;

export const SecretProviderLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SECRET_PROVIDER_LABEL_MAX_CHARS),
);
export type SecretProviderLabel = typeof SecretProviderLabel.Type;

export const OnePasswordSecretProviderConfig = Schema.Struct({
  kind: Schema.Literal("1password"),
  label: SecretProviderLabel,
  account: OnePasswordAccount,
});
export type OnePasswordSecretProviderConfig = typeof OnePasswordSecretProviderConfig.Type;

export const SecretProviderConfig = Schema.Union([OnePasswordSecretProviderConfig]);
export type SecretProviderConfig = typeof SecretProviderConfig.Type;

export const SecretProviderKind = Schema.Literals(["1password"]);
export type SecretProviderKind = SecretProviderConfig["kind"];
