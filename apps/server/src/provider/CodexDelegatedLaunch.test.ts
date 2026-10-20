import { assert, it } from "@effect/vitest";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import { readCodexLaunchCapacity, verifyCodexLaunchBinding } from "./CodexDelegatedLaunch.ts";

function runtime(
  options: {
    provider?: string;
    providers?: unknown;
    chatgptBaseUrl?: string;
    accountId?: string | null;
    accountSwap?: boolean;
    used?: number;
    ordinaryUsageAllowed?: boolean;
  } = {},
) {
  let accounts = 0;
  const calls: string[] = [];
  const client = {
    request: (method: string) =>
      Effect.sync(() => {
        calls.push(method);
        if (method === "config/read")
          return {
            config: {
              model_provider: options.provider ?? "openai",
              model_providers: options.providers,
              chatgpt_base_url: options.chatgptBaseUrl,
            },
          };
        if (method === "account/read")
          return {
            account: {
              type: "chatgpt",
              email:
                options.accountSwap && accounts++ > 0
                  ? "changed@example.com"
                  : "direct@example.com",
              planType: "pro",
            },
          };
        if (method === "account/rateLimits/read")
          return {
            accountId:
              options.accountId === undefined ? "opaque-backend-account" : options.accountId,
            ordinaryUsageAllowed: options.ordinaryUsageAllowed,
            rateLimits: {
              primary: { usedPercent: options.used ?? 1 },
              secondary: { usedPercent: 2 },
            },
          };
        if (method === "thread/read")
          return { thread: { modelProvider: options.provider ?? "openai" } };
        throw new Error(`Unexpected control ${method}`);
      }),
  } as unknown as CodexClient.CodexAppServerClient["Service"];
  return { client, calls };
}

const domains = ["codex:account:direct@example.com", "codex:credential:opaque-backend-account"];

it.effect("admits healthy direct Codex and validates that identity on the dispatch session", () =>
  Effect.gen(function* () {
    const probe = runtime();
    const capacity = yield* readCodexLaunchCapacity(probe.client, {});
    assert.equal(capacity.usageLimits.credentialFingerprint, "opaque-backend-account");
    const dispatch = runtime();
    yield* verifyCodexLaunchBinding(dispatch.client, {}, domains, "native-thread");
    assert.deepEqual(dispatch.calls, [
      "config/read",
      "account/read",
      "account/rateLimits/read",
      "account/read",
      "thread/read",
    ]);
  }),
);

it.effect(
  "denies pools, false config claims, stale bindings and changed accounts before dispatch",
  () =>
    Effect.gen(function* () {
      for (const options of [
        { provider: "pool" },
        { chatgptBaseUrl: "https://pool.invalid" },
        { providers: { openai: { base_url: "https://pool.invalid" } } },
        { accountId: null },
        { accountId: "changed-account" },
        { accountSwap: true },
        { used: 100 },
        { used: -1 },
        { used: 101 },
        { used: NaN },
        { ordinaryUsageAllowed: false },
      ]) {
        const dispatch = runtime(options);
        const error = yield* verifyCodexLaunchBinding(
          dispatch.client,
          {},
          domains,
          "native-thread",
        ).pipe(Effect.flip);
        assert.equal(error._tag, "CodexLaunchCapacityError");
        assert.isFalse(dispatch.calls.includes("turn/start"));
      }
      const direct = runtime();
      yield* verifyCodexLaunchBinding(
        direct.client,
        { OPENAI_BASE_URL: "https://pool.invalid" },
        domains,
        "native-thread",
      ).pipe(Effect.flip);
      yield* verifyCodexLaunchBinding(direct.client, {}, ["pinned"], "native-thread").pipe(
        Effect.flip,
      );
    }),
);
