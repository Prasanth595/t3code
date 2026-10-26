import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The model id Pi selects; the relay maps it to the admin-configured DeepSeek model. */
export const SAAS_LLM_MODEL_ID = "mira";

export const SaasPlanId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/),
);
export type SaasPlanId = typeof SaasPlanId.Type;

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const SaasPlan = Schema.Struct({
  id: SaasPlanId,
  name: TrimmedNonEmptyString,
  monthlyTokenLimit: NonNegativeInt,
  priceCents: NonNegativeInt,
  stripePriceId: Schema.NullOr(TrimmedNonEmptyString),
  isDefault: Schema.Boolean,
  sortOrder: Schema.Int,
});
export type SaasPlan = typeof SaasPlan.Type;

export const SaasUsage = Schema.Struct({
  /** Calendar month in UTC, `YYYY-MM`. */
  period: Schema.String,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  requests: NonNegativeInt,
});
export type SaasUsage = typeof SaasUsage.Type;

export const SaasAccountResponse = Schema.Struct({
  userId: TrimmedNonEmptyString,
  email: Schema.NullOr(Schema.String),
  plan: SaasPlan,
  usage: SaasUsage,
  isAdmin: Schema.Boolean,
  hasLlmKey: Schema.Boolean,
});
export type SaasAccountResponse = typeof SaasAccountResponse.Type;

export const SaasLlmKeyResponse = Schema.Struct({
  /** Shown once; the relay stores only its hash. */
  apiKey: TrimmedNonEmptyString,
  baseUrl: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
});
export type SaasLlmKeyResponse = typeof SaasLlmKeyResponse.Type;

export const SaasAdminUser = Schema.Struct({
  userId: TrimmedNonEmptyString,
  email: Schema.NullOr(Schema.String),
  planId: SaasPlanId,
  subscriptionStatus: Schema.NullOr(Schema.String),
  usage: SaasUsage,
  createdAt: Schema.String,
});
export type SaasAdminUser = typeof SaasAdminUser.Type;

export const SaasAdminUsersResponse = Schema.Struct({
  users: Schema.Array(SaasAdminUser),
});

export const SaasAdminPlansResponse = Schema.Struct({
  plans: Schema.Array(SaasPlan),
});

export const SaasAdminUserPlanRequest = Schema.Struct({
  planId: SaasPlanId,
});

export const SaasAdminSettingsResponse = Schema.Struct({
  deepseekKeyConfigured: Schema.Boolean,
  deepseekModel: TrimmedNonEmptyString,
});
export type SaasAdminSettingsResponse = typeof SaasAdminSettingsResponse.Type;

export const SaasAdminSettingsRequest = Schema.Struct({
  /** Omit to keep the stored key; send an empty string to clear it. */
  deepseekApiKey: Schema.optionalKey(Schema.String),
  deepseekModel: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SaasAdminSettingsRequest = typeof SaasAdminSettingsRequest.Type;

export class SaasForbiddenError extends Schema.TaggedError<SaasForbiddenError>()(
  "SaasForbiddenError",
  { code: Schema.Literal("forbidden") },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return "This account cannot use the admin API.";
  }
}

export class SaasNotFoundError extends Schema.TaggedError<SaasNotFoundError>()(
  "SaasNotFoundError",
  { code: Schema.Literal("not_found"), resource: Schema.Literals(["plan", "user"]) },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return `The ${this.resource} does not exist.`;
  }
}

export class SaasInvalidRequestError extends Schema.TaggedError<SaasInvalidRequestError>()(
  "SaasInvalidRequestError",
  { code: Schema.Literal("invalid_request"), message: Schema.String },
  { httpApiStatus: 400 },
) {}

export const SaasCheckoutRequest = Schema.Struct({
  planId: SaasPlanId,
});
export type SaasCheckoutRequest = typeof SaasCheckoutRequest.Type;

export const SaasRedirectResponse = Schema.Struct({
  url: TrimmedNonEmptyString,
});
export type SaasRedirectResponse = typeof SaasRedirectResponse.Type;

export class SaasBillingUnavailableError extends Schema.TaggedError<SaasBillingUnavailableError>()(
  "SaasBillingUnavailableError",
  {
    code: Schema.Literal("billing_unavailable"),
    reason: Schema.Literals([
      "not_configured",
      "plan_not_purchasable",
      "no_subscription",
      "stripe",
    ]),
  },
  { httpApiStatus: 503 },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_configured":
        return "Payments are not set up yet.";
      case "plan_not_purchasable":
        return "This plan cannot be bought online.";
      case "no_subscription":
        return "This account has no paid subscription to manage.";
      case "stripe":
        return "Stripe could not start the payment. Try again.";
    }
  }
}
