import { OnePasswordSecretProviderConfig, SecretProviderKind } from "@t3tools/contracts";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";

// 1Password secret reference syntax: names outside this charset must be written as item ids.
// It also keeps `{{`, `}}`, and line breaks out of the `op inject` template the server builds.
const NAME = String.raw`[A-Za-z0-9._-](?:[A-Za-z0-9 ._-]*[A-Za-z0-9._-])?`;
const REFERENCE = new RegExp(
  String.raw`^op://${NAME}(?:/${NAME}){2,3}(?:\?[a-z-]+=[A-Za-z0-9_-]+)?$`,
);
const MAX_REFERENCE_LENGTH = 1024;

export const definition = defineSecretProvider({
  kind: SecretProviderKind.make("one_password"),
  label: "1Password",
  configSchema: OnePasswordSecretProviderConfig,
  isReference: (reference) => reference.length <= MAX_REFERENCE_LENGTH && REFERENCE.test(reference),
  referencePlaceholder: "op://vault/item/field",
  invalidReferenceMessage: "Use a 1Password reference like op://vault/item/field.",
});
