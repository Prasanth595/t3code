import { SAAS_LLM_MODEL_ID } from "@t3tools/contracts/saas";
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

export const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
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
    readonly models: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
  }
>()("t3code-relay/saas/LlmProxy") {}

export const make = Effect.gen(function* () {
  const accounts = yield* SaasAccounts.SaasAccounts;
  const httpClient = yield* HttpClient.HttpClient;

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
      const body = parsed as Record<string, unknown>;
      const streaming = body.stream === true;
      const upstreamBody = {
        ...body,
        model: access.model,
        ...(streaming ? { stream_options: { include_usage: true } } : {}),
      };

      const response = yield* httpClient.execute(
        HttpClientRequest.post(DEEPSEEK_CHAT_COMPLETIONS_URL).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(access.apiKey)}`),
          HttpClientRequest.bodyJsonUnsafe(upstreamBody),
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
              return record(userId, tracker.usage);
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
        yield* record(userId, readUsage(completion.value));
        return HttpServerResponse.jsonUnsafe({ ...completion.value, model: SAAS_LLM_MODEL_ID });
      }
      return HttpServerResponse.text(text, { status: response.status, contentType });
    },
    Effect.catch((error) =>
      Effect.logError("Model request failed", { error }).pipe(
        Effect.as(openAiError(502, "upstream_unavailable", "The model is unavailable right now.")),
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

  return LlmProxy.of({ chatCompletions, models });
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
