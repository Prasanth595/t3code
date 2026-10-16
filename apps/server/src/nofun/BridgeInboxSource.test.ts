import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Source from "./BridgeInboxSource.ts";

it.effect.each(["application/json", "text/event-stream"])(
  "preserves opaque owner cursors over the existing bounded list_events protocol (%s)",
  (contentType) =>
    Effect.gen(function* () {
      const cursors: Array<string | null> = [];
      const fetchFn: typeof fetch = async (url, init) => {
        expect(url).toBe("https://bridge.invalid/mcp");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer fixture-owner-token" });
        const body = String(init?.body);
        // Literal requests ensure neither event timestamps nor target filters replace the owner cursor.
        expect(body).toBe(
          stableStringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "list_events",
              arguments: {
                cursor: cursors.length === 0 ? null : "opaque:overlap-and-history",
                limit: 100,
              },
            },
          }),
        );
        cursors.push(cursors.length === 0 ? null : "opaque:overlap-and-history");
        const rpc = stableStringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            isError: false,
            content: [
              {
                type: "text",
                text: stableStringify({
                  events: [],
                  cursor: "opaque:overlap-and-history",
                  has_more: false,
                }),
              },
            ],
          },
        });
        return new Response(
          contentType === "application/json" ? rpc : `event: message\ndata: ${rpc}\n\n`,
          { headers: { "content-type": contentType } },
        );
      };
      const source = yield* Source.BridgeInboxSource.pipe(
        Effect.provide(
          Source.layer(
            { mcpUrl: "https://bridge.invalid/mcp", token: "fixture-owner-token" },
            fetchFn,
          ),
        ),
      );
      const first = yield* source.readPage(null);
      const next = yield* source.readPage(first.cursor);
      expect(next).toEqual({ events: [], cursor: "opaque:overlap-and-history", has_more: false });
      expect(cursors).toHaveLength(2);
    }),
);

it.effect(
  "rejects owner cursor/tool failures and malformed pages rather than inventing a new cursor",
  () =>
    Effect.gen(function* () {
      const source = yield* Source.BridgeInboxSource.pipe(
        Effect.provide(
          Source.layer({ mcpUrl: "https://bridge.invalid/mcp", token: "fixture-token" }, async () =>
            Response.json({
              result: {
                isError: true,
                content: [{ type: "text", text: '{"code":"replay_cursor_invalid"}' }],
              },
            }),
          ),
        ),
      );
      expect((yield* source.readPage("opaque:foreign-owner").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }),
);
