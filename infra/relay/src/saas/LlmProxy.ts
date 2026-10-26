import {
  SAAS_CHAT_DEVICE_HEADER,
  SAAS_LLM_MODEL_ID,
  SaasChatCompletionRequest,
  type SaasChatErrorCode,
} from "@t3tools/contracts/saas";
import { RelayApi } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as SaasAccounts from "./SaasAccounts.ts";
import * as SaasChat from "./SaasChat.ts";

export const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_CHAT_MESSAGES = 200;
const CHAT_SYSTEM_PROMPT =
  "You are Mira, a friendly and helpful assistant. Answer clearly, in the user's language.";
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

const tokenCount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** Reads OpenAI-format `usage` from a completion or a stream chunk. */
export const readUsage = (payload: unknown): TokenUsage | undefined => {
  if (typeof payload !== "object" || payload === null || !("usage" in payload)) return undefined;
  const usage = (payload as { readonly usage: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const fields = usage as Record<string, unknown>;
  return {
    inputTokens: tokenCount(fields.prompt_tokens),
    outputTokens: tokenCount(fields.completion_tokens),
  };
};

/** Tracks the last `usage` seen in an SSE body, split across arbitrary chunks. */
export class SseUsageTracker {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  usage: TokenUsage | undefined;

  push(chunk: Uint8Array) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.readLine(line);
  }

  finish() {
    this.buffer += this.decoder.decode();
    this.readLine(this.buffer);
    this.buffer = "";
  }

  private readLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") return;
    const parsed = parseJson(data);
    if (Option.isSome(parsed)) this.usage = readUsage(parsed.value) ?? this.usage;
  }
}

const openAiError = (status: number, type: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { message, type, code: type } }, { status });

const chatError = (status: number, code: SaasChatErrorCode, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { code, message } }, { status });

const decodeChatRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(SaasChatCompletionRequest),
);

/** Resolves a Clerk bearer to its user id; none when the token does not verify. */
export class ChatBearerVerifier extends Context.Service<
  ChatBearerVerifier,
  (token: string) => Effect.Effect<Option.Option<string>>
>()("t3code-relay/saas/LlmProxy/ChatBearerVerifier") {}

const readBearer = (request: HttpServerRequest.HttpServerRequest) => {
  const header = request.headers.authorization ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice("bearer ".length).trim() : "";
};

export class LlmProxy extends Context.Service<
  LlmProxy,
  {
    readonly chatCompletions: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
    /** Chat mode: open without an account, capped per day instead of metered per month. */
    readonly chat: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
    readonly models: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
  }
>()("t3code-relay/saas/LlmProxy") {}

export const make = Effect.gen(function* () {
  const accounts = yield* SaasAccounts.SaasAccounts;
  const chats = yield* SaasChat.SaasChat;
  const verifyBearer = yield* ChatBearerVerifier;
  const httpClient = yield* HttpClient.HttpClient;

  /** Sends an OpenAI-format body to DeepSeek and relays the reply, reporting its usage. */
  const forward = Effect.fn("relay.llm.forward")(function* (input: {
    readonly apiKey: Redacted.Redacted<string>;
    readonly body: Record<string, unknown>;
    readonly onUsage: (usage: TokenUsage | undefined) => Effect.Effect<void>;
  }) {
    const streaming = input.body.stream === true;
    const response = yield* httpClient.execute(
      HttpClientRequest.post(DEEPSEEK_CHAT_COMPLETIONS_URL).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(input.apiKey)}`),
        HttpClientRequest.bodyJsonUnsafe({
          ...input.body,
          ...(streaming ? { stream_options: { include_usage: true } } : {}),
        }),
      ),
    );
    const contentType = response.headers["content-type"] ?? "application/json";
    yield* Effect.annotateCurrentSpan({ "relay.llm.upstream_status": response.status });

    if (streaming && response.status === 200) {
      const tracker = new SseUsageTracker();
      const body = response.stream.pipe(
        Stream.tap((chunk) => Effect.sync(() => tracker.push(chunk))),
        Stream.ensuring(
          Effect.suspend(() => {
            tracker.finish();
            return input.onUsage(tracker.usage);
          }),
        ),
      );
      return HttpServerResponse.stream(body, {
        status: 200,
        contentType,
        headers: { "cache-control": "no-store" },
      });
    }

    const text = yield* response.text;
    const completion = response.status === 200 ? parseJson(text) : Option.none();
    if (Option.isSome(completion) && typeof completion.value === "object") {
      yield* input.onUsage(readUsage(completion.value));
      return HttpServerResponse.jsonUnsafe({ ...completion.value, model: SAAS_LLM_MODEL_ID });
    }
    return HttpServerResponse.text(text, { status: response.status, contentType });
  });

  const authenticate = Effect.fn("relay.llm.authenticate")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const apiKey = readBearer(request);
    if (apiKey === "") return Option.none();
    return yield* accounts.resolveLlmKey(apiKey);
  });

  const record = (userId: string, usage: TokenUsage | undefined) =>
    usage === undefined
      ? Effect.void
      : accounts
          .recordUsage({ userId, ...usage })
          .pipe(
            Effect.catch((error) => Effect.logWarning("Failed to record model usage", { error })),
          );

  const chatCompletions = Effect.fn("relay.llm.chat_completions")(
    function* (request: HttpServerRequest.HttpServerRequest) {
      const account = yield* authenticate(request);
      if (Option.isNone(account)) {
        return openAiError(401, "invalid_api_key", "Sign in to Mira again to refresh your key.");
      }
      const { userId, plan, usage } = account.value;
      yield* Effect.annotateCurrentSpan({ "user.id": userId, "saas.plan": plan.id });
      if (!plan.agenticEnabled) {
        return openAiError(
          403,
          "agentic_not_in_plan",
          `Agentic mode is not part of the ${plan.name} plan. Upgrade to Pro to use it.`,
        );
      }
      if (!SaasAccounts.hasQuotaLeft(plan, usage)) {
        return openAiError(
          429,
          "insufficient_quota",
          `You used this month's ${plan.monthlyTokenLimit.toLocaleString("en-US")} tokens on the ${plan.name} plan. Upgrade or wait for next month.`,
        );
      }
      const access = yield* accounts.getModelAccess;
      if (access.apiKey === null) {
        return openAiError(503, "model_unavailable", "The model is not configured yet.");
      }

      const raw = yield* request.text;
      if (raw.length > MAX_REQUEST_BYTES) {
        return openAiError(413, "request_too_large", "The request is too large.");
      }
      const parsed = Option.getOrUndefined(parseJson(raw));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return openAiError(400, "invalid_request", "The request body must be a JSON object.");
      }
      return yield* forward({
        apiKey: access.apiKey,
        body: { ...(parsed as Record<string, unknown>), model: access.model },
        onUsage: (usage) => record(userId, usage),
      });
    },
    Effect.catch((error) =>
      Effect.logError("Model request failed", { error }).pipe(
        Effect.as(openAiError(502, "upstream_unavailable", "The model is unavailable right now.")),
      ),
    ),
  );

  const recordChat = (subject: SaasChat.ChatSubject, usage: TokenUsage | undefined) =>
    usage === undefined
      ? Effect.void
      : chats
          .recordTokens({ subject, ...usage })
          .pipe(
            Effect.catch((error) => Effect.logWarning("Failed to record chat usage", { error })),
          );

  /** Who is chatting, which counters they spend, and the reply once those are over the cap. */
  const resolveChatter = Effect.fn("relay.chat.resolve_chatter")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const bearer = readBearer(request);
    if (bearer !== "") {
      const userId = yield* verifyBearer(bearer);
      if (Option.isNone(userId)) {
        return chatError(401, "session_expired", "Sign in again to keep chatting.");
      }
      const account = yield* accounts.getAccount({ userId: userId.value, email: null });
      const limit = account.plan.dailyChatLimit;
      yield* Effect.annotateCurrentSpan({ "user.id": userId.value, "saas.plan": account.plan.id });
      return {
        subjects: [`user:${userId.value}`] as ReadonlyArray<SaasChat.ChatSubject>,
        isOver: ([count = 0]: ReadonlyArray<number>) => SaasChat.isOverLimit(count, limit),
        overLimit: () =>
          chatError(
            429,
            "daily_limit",
            "You reached today's chat limit. It resets at midnight UTC.",
          ),
      };
    }
    const deviceId = request.headers[SAAS_CHAT_DEVICE_HEADER] ?? "";
    if (!SaasChat.isDeviceId(deviceId)) {
      return chatError(400, "invalid_request", "This app is missing its device id.");
    }
    const limit = (yield* accounts.getSettings).anonymousDailyChatLimit;
    const ip = request.headers["cf-connecting-ip"];
    const subjects: ReadonlyArray<SaasChat.ChatSubject> = ip
      ? [`device:${deviceId}`, `ip:${ip}`]
      : [`device:${deviceId}`];
    return {
      subjects,
      isOver: ([device = 0, address = 0]: ReadonlyArray<number>) =>
        limit === 0 ||
        SaasChat.isOverLimit(device, limit) ||
        SaasChat.isOverLimit(address, limit * SaasChat.ANONYMOUS_IP_LIMIT_MULTIPLIER),
      overLimit: () =>
        chatError(
          429,
          "sign_up_required",
          "Create a free account to keep chatting. It takes a minute and chat stays unlimited.",
        ),
    };
  });

  const chat = Effect.fn("relay.chat.completions")(
    function* (request: HttpServerRequest.HttpServerRequest) {
      const raw = yield* request.text;
      if (raw.length > MAX_REQUEST_BYTES) {
        return chatError(413, "invalid_request", "This conversation is too long.");
      }
      const parsed = decodeChatRequest(raw);
      if (Option.isNone(parsed) || parsed.value.messages.length === 0) {
        return chatError(400, "invalid_request", "Send at least one message.");
      }
      const chatter = yield* resolveChatter(request);
      if (HttpServerResponse.isHttpServerResponse(chatter)) return chatter;
      if (chatter.isOver(yield* chats.countMessage(chatter.subjects))) return chatter.overLimit();

      const access = yield* accounts.getModelAccess;
      if (access.apiKey === null) {
        return chatError(503, "model_unavailable", "The model is not configured yet.");
      }
      const subject = chatter.subjects[0] ?? "device:unknown";
      return yield* forward({
        apiKey: access.apiKey,
        body: {
          model: access.model,
          stream: true,
          messages: [
            { role: "system", content: CHAT_SYSTEM_PROMPT },
            ...parsed.value.messages.slice(-MAX_CHAT_MESSAGES),
          ],
        },
        onUsage: (usage) => recordChat(subject, usage),
      });
    },
    Effect.catch((error) =>
      Effect.logError("Chat request failed", { error }).pipe(
        Effect.as(chatError(502, "upstream_unavailable", "The model is unavailable right now.")),
      ),
    ),
  );

  const models = Effect.fn("relay.llm.models")(
    function* (request: HttpServerRequest.HttpServerRequest) {
      const account = yield* authenticate(request);
      if (Option.isNone(account)) {
        return openAiError(401, "invalid_api_key", "Sign in to Mira again to refresh your key.");
      }
      return HttpServerResponse.jsonUnsafe({
        object: "list",
        data: [{ id: SAAS_LLM_MODEL_ID, object: "model", owned_by: "mira" }],
      });
    },
    Effect.catch(() =>
      Effect.succeed(openAiError(502, "upstream_unavailable", "Mira is unavailable right now.")),
    ),
  );

  return LlmProxy.of({ chatCompletions, chat, models });
});

export const layer = Layer.effect(LlmProxy, make).pipe(Layer.provide(FetchHttpClient.layer));

export const layerApi = HttpApiBuilder.group(
  RelayApi,
  "llm",
  Effect.fnUntraced(function* (handlers) {
    const proxy = yield* LlmProxy;
    return handlers
      .handleRaw("chatCompletions", ({ request }) => proxy.chatCompletions(request))
      .handleRaw("models", ({ request }) => proxy.models(request));
  }),
);

export const layerChatApi = HttpApiBuilder.group(
  RelayApi,
  "chat",
  Effect.fnUntraced(function* (handlers) {
    const proxy = yield* LlmProxy;
    return handlers.handleRaw("chatCompletions", ({ request }) => proxy.chat(request));
  }),
);
