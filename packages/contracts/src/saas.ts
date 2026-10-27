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
  /** Agentic mode on a connected computer; `monthlyTokenLimit` meters it. */
  agenticEnabled: Schema.Boolean,
  /** Chat messages per UTC day; 0 means no cap. */
  dailyChatLimit: NonNegativeInt,
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

export const SaasChatAllowance = Schema.Struct({
  messagesToday: NonNegativeInt,
  /** Null when chat is not capped. */
  dailyLimit: Schema.NullOr(NonNegativeInt),
});
export type SaasChatAllowance = typeof SaasChatAllowance.Type;

export const SaasAccountResponse = Schema.Struct({
  userId: TrimmedNonEmptyString,
  email: Schema.NullOr(Schema.String),
  plan: SaasPlan,
  usage: SaasUsage,
  isAdmin: Schema.Boolean,
  hasLlmKey: Schema.Boolean,
  chat: SaasChatAllowance,
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

/** One UTC day of chat mode: messages and tokens, split by signed-in accounts and devices. */
export const SaasAdminChatDay = Schema.Struct({
  day: Schema.String,
  userMessages: NonNegativeInt,
  anonymousMessages: NonNegativeInt,
  activeUsers: NonNegativeInt,
  activeDevices: NonNegativeInt,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
});
export type SaasAdminChatDay = typeof SaasAdminChatDay.Type;

export const SaasAdminStatsResponse = Schema.Struct({
  /** Oldest first, one entry per day including quiet ones. */
  chatDays: Schema.Array(SaasAdminChatDay),
});

/** How much the model thinks before answering; `disabled` skips thinking entirely. */
export const SaasReasoningEffort = Schema.Literals(["disabled", "low", "high", "max"]);
export type SaasReasoningEffort = typeof SaasReasoningEffort.Type;

export const SaasAdminSettingsResponse = Schema.Struct({
  deepseekKeyConfigured: Schema.Boolean,
  deepseekModel: TrimmedNonEmptyString,
  anonymousDailyChatLimit: NonNegativeInt,
  chatReasoningEffort: SaasReasoningEffort,
  agenticReasoningEffort: SaasReasoningEffort,
});
export type SaasAdminSettingsResponse = typeof SaasAdminSettingsResponse.Type;

export const SaasAdminSettingsRequest = Schema.Struct({
  /** Omit to keep the stored key; send an empty string to clear it. */
  deepseekApiKey: Schema.optionalKey(Schema.String),
  deepseekModel: Schema.optionalKey(TrimmedNonEmptyString),
  anonymousDailyChatLimit: Schema.optionalKey(NonNegativeInt),
  chatReasoningEffort: Schema.optionalKey(SaasReasoningEffort),
  agenticReasoningEffort: Schema.optionalKey(SaasReasoningEffort),
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
  { code: Schema.Literal("not_found"), resource: Schema.Literals(["plan", "user", "chat"]) },
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

/** Sent by clients without an account so the relay can count their free chat messages. */
export const SAAS_CHAT_DEVICE_HEADER = "x-mira-device-id";

export const SaasChatId = TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));
export type SaasChatId = typeof SaasChatId.Type;

export const SaasChatRole = Schema.Literals(["user", "assistant"]);
export type SaasChatRole = typeof SaasChatRole.Type;

/** Largest photo or document a chat message can carry. */
export const SAAS_CHAT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Upload header with the file's URI-encoded name; the body is the file's bytes. */
export const SAAS_CHAT_FILE_NAME_HEADER = "x-mira-file-name";
/** Photos the model can see. */
export const SAAS_CHAT_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
/** Documents whose text Mira reads into the conversation. */
export const SAAS_CHAT_DOCUMENT_EXTENSIONS = [
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "txt",
  "md",
  "csv",
  "json",
];

export const SaasChatAttachmentKind = Schema.Literals(["image", "document"]);
export type SaasChatAttachmentKind = typeof SaasChatAttachmentKind.Type;

/** A photo or document stored with the relay; its id is the only key to read it. */
export const SaasChatAttachment = Schema.Struct({
  id: SaasChatId,
  kind: SaasChatAttachmentKind,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: NonNegativeInt,
});
export type SaasChatAttachment = typeof SaasChatAttachment.Type;

export const SaasChatMessage = Schema.Struct({
  id: SaasChatId,
  role: SaasChatRole,
  content: Schema.String,
  createdAt: Schema.String,
  attachments: Schema.optionalKey(Schema.Array(SaasChatAttachment)),
});
export type SaasChatMessage = typeof SaasChatMessage.Type;

export const SaasChatConversation = Schema.Struct({
  id: SaasChatId,
  title: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  messages: Schema.Array(SaasChatMessage),
});
export type SaasChatConversation = typeof SaasChatConversation.Type;

export const SaasChatSummary = Schema.Struct({
  id: SaasChatId,
  title: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type SaasChatSummary = typeof SaasChatSummary.Type;

/** The relay lists at most this many chats, newest first; older ones stay stored. */
export const SAAS_MAX_LISTED_CHATS = 200;

export const SaasChatListResponse = Schema.Struct({
  chats: Schema.Array(SaasChatSummary),
});

/** The body clients post to `/v1/chat/completions`; the reply streams back as OpenAI SSE. */
export const SaasChatCompletionRequest = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      role: SaasChatRole,
      content: Schema.String,
      attachments: Schema.optionalKey(Schema.Array(SaasChatAttachment)),
    }),
  ),
});
export type SaasChatCompletionRequest = typeof SaasChatCompletionRequest.Type;

/**
 * Codes in a failed chat reply's `{ error: { code, message } }` body. `sign_up_required` means
 * the messages without an account are used up today; `daily_limit` is the plan's daily cap.
 */
export const SaasChatErrorCode = Schema.Literals([
  "sign_up_required",
  "session_expired",
  "daily_limit",
  "agentic_not_in_plan",
  "model_unavailable",
  "invalid_request",
  "upstream_unavailable",
]);
export type SaasChatErrorCode = typeof SaasChatErrorCode.Type;
