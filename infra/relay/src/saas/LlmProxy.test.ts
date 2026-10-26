import { describe, expect, it } from "@effect/vitest";
import type { SaasPlan } from "@t3tools/contracts/saas";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as LlmProxy from "./LlmProxy.ts";
import * as SaasAccounts from "./SaasAccounts.ts";

const plan: SaasPlan = {
  id: "free",
  name: "Free",
  monthlyTokenLimit: 1_000,
  priceCents: 0,
  stripePriceId: null,
  isDefault: true,
  sortOrder: 0,
};

const account = (usedInputTokens: number): SaasAccounts.SaasAccountView => ({
  userId: "user_1",
  email: "user@example.com",
  plan,
  usage: { period: "2026-10", inputTokens: usedInputTokens, outputTokens: 0, requests: 1 },
  hasLlmKey: true,
});

const encoder = new TextEncoder();

function makeHarness(options: {
  readonly usedInputTokens?: number;
  readonly upstream: (request: HttpClientRequest.HttpClientRequest) => Response;
}) {
  const sent: Array<HttpClientRequest.HttpClientRequest> = [];
  const recorded: Array<{ inputTokens: number; outputTokens: number }> = [];
  const layer = Layer.effect(LlmProxy.LlmProxy, LlmProxy.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(SaasAccounts.SaasAccounts, {
          resolveLlmKey: (apiKey) =>
            Effect.succeed(
              apiKey === "mira_valid-key-0123456789"
                ? Option.some(account(options.usedInputTokens ?? 0))
                : Option.none(),
            ),
          getModelAccess: Effect.succeed({
            apiKey: Redacted.make("sk-deepseek"),
            model: "deepseek-chat",
          }),
          recordUsage: (input) =>
            Effect.sync(() => {
              recorded.push({ inputTokens: input.inputTokens, outputTokens: input.outputTokens });
            }),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              sent.push(request);
              return HttpClientResponse.fromWeb(request, options.upstream(request));
            }),
          ),
        ),
      ),
    ),
  );
  const chat = (body: unknown, apiKey = "mira_valid-key-0123456789") =>
    LlmProxy.LlmProxy.pipe(
      Effect.flatMap((proxy) =>
        proxy.chatCompletions(
          HttpServerRequest.fromWeb(
            new Request("https://relay.test/v1/llm/chat/completions", {
              method: "POST",
              headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
          ),
        ),
      ),
      Effect.provide(layer),
    );
  return { sent, recorded, chat };
}

const readText = (response: HttpServerResponse.HttpServerResponse) =>
  Effect.promise(() => HttpServerResponse.toWeb(response).text());

const sentJson = (request: HttpClientRequest.HttpClientRequest | undefined) =>
  request?.body._tag === "Uint8Array"
    ? (JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>)
    : undefined;

describe("LlmProxy", () => {
  it.effect(
    "refuses a request once the plan's monthly tokens are used, without calling DeepSeek",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          usedInputTokens: 1_000,
          upstream: () => new Response("{}"),
        });
        const response = yield* harness.chat({ messages: [] });
        expect(response.status).toBe(429);
        expect(JSON.parse(yield* readText(response)).error.type).toBe("insufficient_quota");
        expect(harness.sent).toEqual([]);
      }),
  );

  it.effect("rejects unknown keys", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ upstream: () => new Response("{}") });
      const response = yield* harness.chat({ messages: [] }, "mira_revoked-key-0123456789");
      expect(response.status).toBe(401);
      expect(harness.sent).toEqual([]);
    }),
  );

  it.effect("sends the configured model with the admin key and records completion usage", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        upstream: () =>
          Response.json({
            id: "c1",
            model: "deepseek-chat",
            choices: [],
            usage: { prompt_tokens: 12, completion_tokens: 30 },
          }),
      });
      const response = yield* harness.chat({ model: "mira", messages: [] });
      expect(response.status).toBe(200);
      expect(JSON.parse(yield* readText(response)).model).toBe("mira");
      expect(sentJson(harness.sent[0])?.model).toBe("deepseek-chat");
      expect(harness.sent[0]?.headers.authorization).toBe("Bearer sk-deepseek");
      expect(harness.recorded).toEqual([{ inputTokens: 12, outputTokens: 30 }]);
    }),
  );

  it.effect("streams through and records the usage chunk once the stream ends", () =>
    Effect.gen(function* () {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tok',
        'ens":7,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
      ];
      const harness = makeHarness({
        upstream: () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      const response = yield* harness.chat({ stream: true, messages: [] });
      expect(harness.recorded).toEqual([]);
      expect(yield* readText(response)).toBe(chunks.join(""));
      expect(sentJson(harness.sent[0])?.stream_options).toEqual({ include_usage: true });
      expect(harness.recorded).toEqual([{ inputTokens: 7, outputTokens: 3 }]);
    }),
  );
});
