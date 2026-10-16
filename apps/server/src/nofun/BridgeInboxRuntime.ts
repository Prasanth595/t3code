import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as Inbox from "./BridgeInbox.ts";
import * as Source from "./BridgeInboxSource.ts";

const decodeConfig = Schema.decodeEffect(Schema.fromJsonString(Inbox.Config));

// No ambient URL/token reuse, automatic subscription, default target or default binding.
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const raw = process.env.NOFUN_BRIDGE_INBOX_CONFIG;
    const config = raw ? yield* decodeConfig(raw) : null;
    const token = process.env.NOFUN_BRIDGE_INBOX_TOKEN;
    const webhookSecret = process.env.NOFUN_BRIDGE_INBOX_WEBHOOK_SECRET;
    if (
      config &&
      (!token || !webhookSecret || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(webhookSecret))
    ) {
      return yield* new Inbox.BridgeInboxError({
        operation: "config",
        cause: "explicit token and Standard Webhooks secret required",
      });
    }
    if (config) {
      const url = yield* Effect.try({
        try: () => new URL(config.mcpUrl),
        catch: (cause) => new Inbox.BridgeInboxError({ operation: "config", cause }),
      });
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
        return yield* new Inbox.BridgeInboxError({
          operation: "config",
          cause: "HTTPS MCP URL without credentials required",
        });
      }
    }
    const service = Inbox.layerWithConfig(config, webhookSecret ? { webhookSecret } : {}).pipe(
      Layer.provide(Source.layer(config && token ? { mcpUrl: config.mcpUrl, token } : null)),
    );
    const worker = Layer.effectDiscard(
      Effect.gen(function* () {
        if (!config) return;
        const inbox = yield* Inbox.BridgeInbox;
        yield* Effect.gen(function* () {
          for (;;) {
            yield* inbox.pull.pipe(
              Effect.catch(() => Effect.logWarning("bridge inbox pull failed; cursor retained")),
            );
            yield* inbox.drain.pipe(
              Effect.catch(() =>
                Effect.logWarning("bridge inbox dispatch failed; pending rows retained"),
              ),
            );
            yield* inbox.summary.pipe(
              Effect.flatMap((summary) =>
                Effect.logDebug("bridge informational inbox disposition", summary),
              ),
              Effect.catch(() => Effect.logWarning("bridge inbox status unavailable")),
            );
            yield* Effect.sleep(5000);
          }
        }).pipe(Effect.forkScoped);
      }),
    );
    return worker.pipe(Layer.provideMerge(service));
  }),
);

/** Signature and durable intake belong to the service; this route only decodes and maps. */
export const routeLayer = HttpRouter.add(
  "POST",
  "/api/bridge/inbox",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const inbox = yield* Inbox.BridgeInbox;
    const body = yield* request.text.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(256 * 1024)),
      Effect.option,
    );
    if (body._tag === "None")
      return HttpServerResponse.jsonUnsafe(
        { error: "body_too_large_or_unreadable" },
        { status: 413 },
      );
    const result = yield* inbox
      .receiveCallback(body.value, request.headers)
      .pipe(
        Effect.catch(() => Effect.succeed({ status: 503, body: { error: "inbox_unavailable" } })),
      );
    return HttpServerResponse.jsonUnsafe(result.body, { status: result.status });
  }),
);
