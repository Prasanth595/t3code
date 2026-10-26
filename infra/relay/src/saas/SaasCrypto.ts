import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export class SaasSettingDecryptError extends Schema.TaggedError<SaasSettingDecryptError>()(
  "SaasSettingDecryptError",
  { cause: Schema.optional(Schema.Defect()) },
) {}

const LLM_KEY_PREFIX = "mira_";
const LLM_KEY_BYTES = 32;
const IV_BYTES = 12;

/** Secret the relay derives the settings encryption key from. */
export class SaasSettingsKey extends Context.Service<SaasSettingsKey, Redacted.Redacted<string>>()(
  "t3code-relay/saas/SaasCrypto/SaasSettingsKey",
) {}

const randomBytes = (length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length));

export const generateLlmApiKey = () =>
  `${LLM_KEY_PREFIX}${Base64Url.encode(randomBytes(LLM_KEY_BYTES))}`;

export const isLlmApiKey = (value: string) =>
  value.startsWith(LLM_KEY_PREFIX) && value.length > LLM_KEY_PREFIX.length + 16;

const sha256 = (data: string) =>
  Effect.promise(() =>
    globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(data)),
  ).pipe(Effect.map((digest) => new Uint8Array(digest)));

export const hashLlmApiKey = (apiKey: string) =>
  sha256(apiKey).pipe(Effect.map((digest) => Hex.encode(digest)));

const importKey = (secret: Redacted.Redacted<string>) =>
  sha256(Redacted.value(secret)).pipe(
    Effect.flatMap((raw) =>
      Effect.promise(() =>
        globalThis.crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]),
      ),
    ),
  );

/** AES-GCM with a fresh IV, encoded as `<iv>.<ciphertext>` in base64url. */
export const encryptSetting = Effect.fn("SaasCrypto.encryptSetting")(function* (
  secret: Redacted.Redacted<string>,
  plaintext: string,
) {
  const key = yield* importKey(secret);
  const iv = randomBytes(IV_BYTES);
  const ciphertext = yield* Effect.promise(() =>
    globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  return `${Base64Url.encode(iv)}.${Base64Url.encode(new Uint8Array(ciphertext))}`;
});

export const decryptSetting = Effect.fn("SaasCrypto.decryptSetting")(function* (
  secret: Redacted.Redacted<string>,
  encoded: string,
) {
  const [ivPart, dataPart] = encoded.split(".");
  if (ivPart === undefined || dataPart === undefined) {
    return yield* new SaasSettingDecryptError({});
  }
  const iv = yield* Effect.fromResult(Base64Url.decode(ivPart));
  const data = yield* Effect.fromResult(Base64Url.decode(dataPart));
  const key = yield* importKey(secret);
  const plaintext = yield* Effect.tryPromise({
    try: () =>
      globalThis.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(iv) },
        key,
        new Uint8Array(data),
      ),
    catch: (cause) => new SaasSettingDecryptError({ cause }),
  });
  return new TextDecoder().decode(plaintext);
});
