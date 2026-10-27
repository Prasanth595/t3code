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

import * as ChatAttachments from "./ChatAttachments.ts";
import * as LlmProxy from "./LlmProxy.ts";
import * as SaasAccounts from "./SaasAccounts.ts";
import * as SaasChat from "./SaasChat.ts";

const plan: SaasPlan = {
  id: "free",
  name: "Free",
  monthlyTokenLimit: 1_000,
  priceCents: 0,
  stripePriceId: null,
  isDefault: true,
  sortOrder: 0,
  agenticEnabled: true,
  dailyChatLimit: 0,
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
  readonly plan?: Partial<SaasPlan>;
  readonly anonymousDailyChatLimit?: number;
  readonly upstream: (request: HttpClientRequest.HttpClientRequest) => Response;
}) {
  const accountPlan = { ...plan, ...options.plan };
  const counts = new Map<string, number>();
  const sent: Array<HttpClientRequest.HttpClientRequest> = [];
  const recorded: Array<{ inputTokens: number; outputTokens: number }> = [];
  const files = new Map<string, { readonly bytes: Uint8Array; readonly contentType: string }>();
  const layer = Layer.effect(LlmProxy.LlmProxy, LlmProxy.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(SaasAccounts.SaasAccounts, {
          resolveLlmKey: (apiKey) =>
            Effect.succeed(
              apiKey === "mira_valid-key-0123456789"
                ? Option.some({ ...account(options.usedInputTokens ?? 0), plan: accountPlan })
                : Option.none(),
            ),
          getAccount: () => Effect.succeed({ ...account(0), plan: accountPlan }),
          getSettings: Effect.succeed({
            deepseekKeyConfigured: true,
            deepseekModel: "deepseek-chat",
            anonymousDailyChatLimit: options.anonymousDailyChatLimit ?? 10,
            chatReasoningEffort: "low" as const,
            agenticReasoningEffort: "disabled" as const,
          }),
          getModelAccess: Effect.succeed({
            apiKey: Redacted.make("sk-deepseek"),
            model: "deepseek-chat",
            chatReasoningEffort: "low" as const,
            agenticReasoningEffort: "disabled" as const,
          }),
          recordUsage: (input) =>
            Effect.sync(() => {
              recorded.push({ inputTokens: input.inputTokens, outputTokens: input.outputTokens });
            }),
        }),
        Layer.mock(SaasChat.SaasChat, {
          countMessage: (subjects) =>
            Effect.sync(() =>
              subjects.map((subject) => {
                const next = (counts.get(subject) ?? 0) + 1;
                counts.set(subject, next);
                return next;
              }),
            ),
          recordTokens: () => Effect.void,
        }),
        Layer.succeed(LlmProxy.ChatBearerVerifier, (token) =>
          Effect.succeed(token === "clerk-valid" ? Option.some("user_1") : Option.none()),
        ),
        ChatAttachments.layer.pipe(
          Layer.provide(
            Layer.succeed(ChatAttachments.ChatAttachmentStore, {
              put: (key, bytes, contentType) =>
                Effect.sync(() => void files.set(key, { bytes, contentType })),
              get: (key) => Effect.sync(() => Option.fromNullishOr(files.get(key))),
            }),
          ),
        ),
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
  const chatMode = (
    headers: Record<string, string>,
    body: unknown = { messages: [{ role: "user", content: "Hi" }] },
  ) =>
    LlmProxy.LlmProxy.pipe(
      Effect.flatMap((proxy) =>
        proxy.chat(
          HttpServerRequest.fromWeb(
            new Request("https://relay.test/v1/chat/completions", {
              method: "POST",
              headers: { "content-type": "application/json", ...headers },
              body: JSON.stringify(body),
            }),
          ),
        ),
      ),
      Effect.provide(layer),
    );
  const upload = (headers: Record<string, string>, body: BodyInit) =>
    LlmProxy.LlmProxy.pipe(
      Effect.flatMap((proxy) =>
        proxy.uploadAttachment(
          HttpServerRequest.fromWeb(
            new Request("https://relay.test/v1/chat/attachments", {
              method: "POST",
              headers,
              body,
            }),
          ),
        ),
      ),
      Effect.provide(layer),
    );
  return { sent, recorded, chat, chatMode, upload };
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
      expect(sentJson(harness.sent[0])?.thinking).toEqual({ type: "disabled" });
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

  it.effect("refuses agentic requests on a plan without agentic mode", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        plan: { agenticEnabled: false },
        upstream: () => new Response("{}"),
      });
      const response = yield* harness.chat({ messages: [] });
      expect(response.status).toBe(403);
      expect(JSON.parse(yield* readText(response)).error.type).toBe("agentic_not_in_plan");
      expect(harness.sent).toEqual([]);
    }),
  );
});

describe("chat mode", () => {
  const device = { "x-mira-device-id": "device-0123456789abcdef" };
  const sse = () =>
    new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });

  it.effect("asks a device without an account to sign up after its free messages", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ anonymousDailyChatLimit: 2, upstream: sse });
      expect((yield* harness.chatMode(device)).status).toBe(200);
      expect((yield* harness.chatMode(device)).status).toBe(200);
      const refused = yield* harness.chatMode(device);
      expect(refused.status).toBe(429);
      expect(JSON.parse(yield* readText(refused)).error.code).toBe("sign_up_required");
      expect(harness.sent).toHaveLength(2);
      expect(sentJson(harness.sent[0])?.stream).toBe(true);
      expect(sentJson(harness.sent[0])?.reasoning_effort).toBe("low");
    }),
  );

  it.effect("keeps chat open for a signed-in plan with no daily cap", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        anonymousDailyChatLimit: 1,
        plan: { agenticEnabled: false, dailyChatLimit: 0 },
        upstream: sse,
      });
      for (let index = 0; index < 3; index++) {
        expect((yield* harness.chatMode({ authorization: "Bearer clerk-valid" })).status).toBe(200);
      }
    }),
  );

  it.effect("stops a signed-in plan at its daily cap and rejects stale sessions", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ plan: { dailyChatLimit: 1 }, upstream: sse });
      expect((yield* harness.chatMode({ authorization: "Bearer clerk-valid" })).status).toBe(200);
      const capped = yield* harness.chatMode({ authorization: "Bearer clerk-valid" });
      expect(JSON.parse(yield* readText(capped)).error.code).toBe("daily_limit");
      const stale = yield* harness.chatMode({ authorization: "Bearer clerk-stale" });
      expect(stale.status).toBe(401);
      expect(JSON.parse(yield* readText(stale)).error.code).toBe("session_expired");
    }),
  );
});

describe("chat mode search and attachments", () => {
  const device = { "x-mira-device-id": "device-0123456789abcdef" };
  const stream = (...events: ReadonlyArray<unknown>) =>
    new Response(
      [...events.map((event) => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"].join(""),
      { headers: { "content-type": "text/event-stream" } },
    );

  it.effect("runs the model's web search and keeps streaming the reply", () =>
    Effect.gen(function* () {
      let modelTurns = 0;
      const harness = makeHarness({
        upstream: (request) => {
          if (request.url.endsWith("/v1/tools/search")) {
            return Response.json({
              results: [{ title: "Weather", url: "https://w.test", summary: "Sunny, 21C" }],
            });
          }
          modelTurns += 1;
          return modelTurns === 1
            ? stream(
                {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "call_1",
                            function: { name: "web_search", arguments: '{"query":"weather' },
                          },
                        ],
                      },
                    },
                  ],
                },
                {
                  choices: [
                    { delta: { tool_calls: [{ index: 0, function: { arguments: ' Iasi"}' } }] } },
                  ],
                  usage: { prompt_tokens: 5, completion_tokens: 2 },
                },
              )
            : stream(
                { choices: [{ delta: { content: "It is sunny." } }] },
                { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } },
              );
        },
      });
      const body = yield* readText(yield* harness.chatMode(device));
      expect(body).toContain('"mira":{"status":"searching"}');
      expect(body).toContain("It is sunny.");
      expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
      const search = harness.sent.find((request) => request.url.endsWith("/v1/tools/search"));
      expect(sentJson(search)?.query).toBe("weather Iasi");
      const followUp = sentJson(harness.sent.at(-1))?.messages as ReadonlyArray<{
        role: string;
        content: unknown;
      }>;
      expect(followUp.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1" });
      expect(String(followUp.at(-1)?.content)).toContain("Sunny, 21C");
    }),
  );

  it.effect("keeps the search tool declared but unusable on the last round", () =>
    Effect.gen(function* () {
      // A model that saw tool results but no tool declaration writes its next call as plain text.
      const harness = makeHarness({
        upstream: (request) =>
          request.url.endsWith("/v1/tools/search")
            ? Response.json({ results: [] })
            : sentJson(request)?.tool_choice === "none"
              ? stream({ choices: [{ delta: { content: "Done." } }] })
              : stream({
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: `call_${harness.sent.length}`,
                            function: { name: "web_search", arguments: '{"query":"ai"}' },
                          },
                        ],
                      },
                    },
                  ],
                }),
      });
      expect(yield* readText(yield* harness.chatMode(device))).toContain("Done.");
      const turns = harness.sent
        .filter((request) => !request.url.endsWith("/v1/tools/search"))
        .map((request) => sentJson(request));
      expect(turns.slice(0, -1).every((turn) => turn?.tool_choice === "auto")).toBe(true);
      const last = turns.at(-1);
      expect(last?.tools).toHaveLength(1);
      expect(last?.tool_choice).toBe("none");
    }),
  );

  it.effect("stores a document and reads its text into the conversation", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ upstream: () => stream() });
      const uploaded = yield* harness.upload(
        { ...device, "content-type": "text/csv", "x-mira-file-name": "prices.csv" },
        "item,price\napple,3",
      );
      expect(uploaded.status).toBe(200);
      const attachment = JSON.parse(yield* readText(uploaded));
      expect(attachment).toMatchObject({ kind: "document", name: "prices.csv", sizeBytes: 18 });

      yield* readText(
        yield* harness.chatMode(device, {
          messages: [{ role: "user", content: "Total?", attachments: [attachment] }],
        }),
      );
      const messages = sentJson(harness.sent[0])?.messages as ReadonlyArray<{ content: unknown }>;
      expect(String(messages.at(-1)?.content)).toContain('<document name="prices.csv">');
      expect(String(messages.at(-1)?.content)).toContain("apple,3");
    }),
  );

  it.effect("sends recent photos to the model and refuses unreadable formats", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ upstream: () => stream() });
      const photo = JSON.parse(
        yield* readText(
          yield* harness.upload(
            { ...device, "content-type": "image/png", "x-mira-file-name": "cat.png" },
            new Uint8Array([1, 2, 3]),
          ),
        ),
      );
      expect(photo.kind).toBe("image");
      yield* readText(
        yield* harness.chatMode(device, {
          messages: [{ role: "user", content: "What is this?", attachments: [photo] }],
        }),
      );
      const messages = sentJson(harness.sent[0])?.messages as ReadonlyArray<{ content: unknown }>;
      expect(messages.at(-1)?.content).toEqual([
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
      ]);

      const legacy = yield* harness.upload(
        { ...device, "content-type": "application/msword", "x-mira-file-name": "old.doc" },
        "x",
      );
      expect(legacy.status).toBe(415);
    }),
  );
});
