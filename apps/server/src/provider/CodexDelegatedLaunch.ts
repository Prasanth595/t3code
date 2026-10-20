import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import type * as CodexClient from "effect-codex-app-server/client";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { codexRateLimitsToLimits } from "./codexUsageLimits.ts";

export class CodexLaunchCapacityError extends Schema.TaggedError<CodexLaunchCapacityError>()(
  "CodexLaunchCapacityError",
  { code: Schema.Literals(["usage_limit", "delegated_capacity_unverified"]) },
) {}

// Configured instance labels cannot establish which account a wrapper dispatches.
// Read the resolved runtime's controls and require the backend's account binding.
export const readCodexLaunchCapacity = Effect.fn("readCodexLaunchCapacity")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
  environment: NodeJS.ProcessEnv,
) {
  const { config } = yield* client.request("config/read", { includeLayers: false });
  const providers = config.model_providers;
  if (
    (config.model_provider != null && config.model_provider !== "openai") ||
    (typeof providers === "object" && providers !== null && "openai" in providers) ||
    config.chatgpt_base_url != null ||
    environment.OPENAI_BASE_URL?.trim() ||
    environment.OPENAI_API_KEY?.trim() ||
    environment.CODEX_API_KEY?.trim()
  )
    return yield* new CodexLaunchCapacityError({ code: "delegated_capacity_unverified" });
  const account = (yield* client.request("account/read", {})).account;
  const limits = yield* client.request("account/rateLimits/read", null);
  const confirmed = (yield* client.request("account/read", {})).account;
  if (
    account?.type !== "chatgpt" ||
    confirmed?.type !== "chatgpt" ||
    !account.email?.trim() ||
    account.email !== confirmed.email ||
    !limits.accountId?.trim()
  )
    return yield* new CodexLaunchCapacityError({ code: "delegated_capacity_unverified" });
  const raw = limits.rateLimitsByLimitId?.codex ?? limits.rateLimits;
  if (
    [raw.primary, raw.secondary].some(
      (w) => !w || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100,
    )
  )
    return yield* new CodexLaunchCapacityError({ code: "delegated_capacity_unverified" });
  const usageLimits: ServerProviderUsageLimits = {
    ...codexRateLimitsToLimits({
      snapshot: limits.rateLimits,
      rateLimitsByLimitId: limits.rateLimitsByLimitId,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
    }),
    credentialFingerprint: limits.accountId,
  };
  if (
    limits.ordinaryUsageAllowed === false ||
    usageLimits.windows.some((w) => w.usedPercent >= 100)
  )
    return yield* new CodexLaunchCapacityError({ code: "usage_limit" });
  if (!["primary", "secondary"].every((id) => usageLimits.windows.some((w) => w.id === id)))
    return yield* new CodexLaunchCapacityError({ code: "delegated_capacity_unverified" });
  return { email: account.email.trim().toLowerCase(), usageLimits };
});

export const verifyCodexLaunchBinding = Effect.fn("verifyCodexLaunchBinding")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
  environment: NodeJS.ProcessEnv,
  domains: ReadonlyArray<string>,
  nativeThreadId: string,
) {
  const capacity = yield* readCodexLaunchCapacity(client, environment);
  const { thread } = yield* client.request("thread/read", {
    threadId: nativeThreadId,
    includeTurns: false,
  });
  if (
    thread.modelProvider !== "openai" ||
    !domains.includes(`codex:account:${capacity.email}`) ||
    !domains.includes(`codex:credential:${capacity.usageLimits.credentialFingerprint}`)
  )
    return yield* new CodexLaunchCapacityError({ code: "delegated_capacity_unverified" });
});
