import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

import * as SaasCrypto from "./SaasCrypto.ts";

describe("SaasCrypto", () => {
  it.effect("round-trips a setting and refuses it under another secret", () =>
    Effect.gen(function* () {
      const secret = Redacted.make("secret-a");
      const encrypted = yield* SaasCrypto.encryptSetting(secret, "sk-deepseek");
      expect(encrypted).not.toContain("sk-deepseek");
      expect(yield* SaasCrypto.decryptSetting(secret, encrypted)).toBe("sk-deepseek");
      const wrong = yield* Effect.result(
        SaasCrypto.decryptSetting(Redacted.make("secret-b"), encrypted),
      );
      expect(Result.isFailure(wrong)).toBe(true);
    }),
  );

  it.effect("issues distinct keys that hash stably", () =>
    Effect.gen(function* () {
      const first = SaasCrypto.generateLlmApiKey();
      const second = SaasCrypto.generateLlmApiKey();
      expect(first).not.toBe(second);
      expect(SaasCrypto.isLlmApiKey(first)).toBe(true);
      expect(SaasCrypto.isLlmApiKey("sk-other")).toBe(false);
      expect(yield* SaasCrypto.hashLlmApiKey(first)).toBe(yield* SaasCrypto.hashLlmApiKey(first));
    }),
  );
});
