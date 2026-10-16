import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const Page = Schema.Struct({
  events: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(100)),
  cursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
  has_more: Schema.Boolean,
});
export class BridgeInboxSourceError extends Schema.TaggedError<BridgeInboxSourceError>()(
  "BridgeInboxSourceError",
  { cause: Schema.Defect() },
) {}
export class BridgeInboxSource extends Context.Service<
  BridgeInboxSource,
  {
    readonly readPage: (
      cursor: string | null,
    ) => Effect.Effect<typeof Page.Type, BridgeInboxSourceError>;
  }
>()("t3/nofun/BridgeInboxSource") {}

const Rpc = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optional(Schema.Boolean),
    content: Schema.Array(
      Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
    ),
  }),
});

const decodeRpc = Schema.decodeEffect(Schema.fromJsonString(Rpc));
const decodePage = Schema.decodeUnknownEffect(Schema.fromJsonString(Page));

/** Same bounded, stateless tools/call protocol used by the bridge's event-replay worker. */
export const layer = (
  config: { readonly mcpUrl: string; readonly token: string } | null,
  fetchFn: typeof fetch = globalThis.fetch,
) =>
  Layer.succeed(BridgeInboxSource, {
    readPage: (cursor) =>
      Effect.gen(function* () {
        const text = yield* Effect.tryPromise({
          try: async () => {
            if (!config) throw new Error("disabled");
            const response = await fetchFn(config.mcpUrl, {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.timeout(15_000),
              headers: {
                Authorization: `Bearer ${config.token}`,
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
              },
              body: stableStringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "list_events", arguments: { cursor, limit: 100 } },
              }),
            });
            if (!response.ok || !response.body) throw new Error("read_failed");
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let text = "";
            let bytes = 0;
            try {
              for (;;) {
                const part = await reader.read();
                if (part.done) break;
                bytes += part.value.byteLength;
                if (bytes > 2 * 1024 * 1024) throw new Error("page_too_large");
                text += decoder.decode(part.value, { stream: true });
              }
              text += decoder.decode();
            } finally {
              await reader.cancel();
            }
            if (response.headers.get("content-type")?.includes("text/event-stream")) {
              text =
                text
                  .split(/\r?\n/)
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trim())
                  .find((line) => line.includes('"result"')) ?? "";
            }
            return text;
          },
          catch: (cause) => new BridgeInboxSourceError({ cause }),
        });
        const rpc = yield* decodeRpc(text);
        if (rpc.result.isError)
          return yield* new BridgeInboxSourceError({ cause: "tool_rejected" });
        const content = rpc.result.content.find((item) => item.type === "text")?.text;
        return yield* decodePage(content);
      }).pipe(Effect.mapError((cause) => new BridgeInboxSourceError({ cause }))),
  });
