import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpProviderSessions from "./McpProviderSessions.ts";

const threadId = ThreadId.make("thread-mcp-provider-sessions");
const page = (name: string) => ({
  attachmentId: `${threadId}-${name}-html`,
  title: "Revenue",
  height: 240,
});
const revenue = { html: "<p>Revenue</p>", title: "Revenue", height: 240 };

describe("McpProviderSessions html_render pages", () => {
  it.effect("matches a height the agent reports as a numeric string", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.recordHtmlRender(threadId, revenue, page("first"));

      assert.strictEqual(
        yield* sessions.takeHtmlRender(threadId, { ...revenue, height: "240px" }),
        undefined,
      );
      assert.strictEqual(
        yield* sessions.takeHtmlRender(threadId, { ...revenue, height: "" }),
        undefined,
      );
      assert.deepStrictEqual(
        yield* sessions.takeHtmlRender(threadId, { ...revenue, height: " 240 " }),
        page("first"),
      );
      // Each page goes to one call.
      assert.strictEqual(yield* sessions.takeHtmlRender(threadId, revenue), undefined);
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("takes the very page a call reported", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.recordHtmlRender(threadId, revenue, page("first"));
      yield* sessions.recordHtmlRender(threadId, revenue, page("second"));

      // A page this thread never kept leaves the kept pages for their calls.
      assert.strictEqual(
        yield* sessions.takeHtmlRender(threadId, revenue, page("unknown")),
        undefined,
      );
      assert.deepStrictEqual(
        yield* sessions.takeHtmlRender(threadId, revenue, page("second")),
        page("second"),
      );
      assert.deepStrictEqual(yield* sessions.takeHtmlRender(threadId, revenue), page("first"));
      assert.strictEqual(yield* sessions.takeHtmlRender(threadId, revenue), undefined);
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("tells pages with the same title and height apart by their html", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const byRegion = { ...revenue, html: "<p>Revenue by region</p>" };
      const byMonth = { ...revenue, html: "<p>Revenue by month</p>" };
      yield* sessions.recordHtmlRender(threadId, byRegion, page("region"));
      yield* sessions.recordHtmlRender(threadId, byMonth, page("month"));

      // The calls complete in the reverse order of their pages.
      assert.deepStrictEqual(yield* sessions.takeHtmlRender(threadId, byMonth), page("month"));
      assert.deepStrictEqual(yield* sessions.takeHtmlRender(threadId, byRegion), page("region"));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("matches a page whose html the agent bounded to its last 8,000 characters", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const rows = (label: string) =>
        Array.from({ length: 500 }, (_, row) => `<tr><td>${label} ${row}</td></tr>`).join("");
      const byRegion = { ...revenue, html: `<table>${rows("Region")}</table>` };
      const byMonth = { ...revenue, html: `<table>${rows("Month")}</table>` };
      const bounded = (html: string) => `[Earlier output truncated]\n\n${html.slice(-8_000)}`;
      assert.isAbove(byRegion.html.length, 8_000);
      yield* sessions.recordHtmlRender(threadId, byRegion, page("region"));
      yield* sessions.recordHtmlRender(threadId, byMonth, page("month"));

      // An end the page does not have, or more of it than a kept page holds,
      // matches no page.
      assert.strictEqual(
        yield* sessions.takeHtmlRender(threadId, {
          ...revenue,
          html: bounded(`${byMonth.html}<p>Notes</p>`),
        }),
        undefined,
      );
      assert.strictEqual(
        yield* sessions.takeHtmlRender(threadId, {
          ...revenue,
          html: `[Earlier output truncated]\n\n${byMonth.html.slice(-8_001)}`,
        }),
        undefined,
      );
      assert.deepStrictEqual(
        yield* sessions.takeHtmlRender(threadId, { ...byMonth, html: bounded(byMonth.html) }),
        page("month"),
      );
      // The whole page still matches.
      assert.deepStrictEqual(yield* sessions.takeHtmlRender(threadId, byRegion), page("region"));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("takes no page for a call without html or with pages it cannot tell apart", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.recordHtmlRender(threadId, revenue, page("first"));

      assert.strictEqual(
        yield* sessions.takeHtmlRender(threadId, { title: "Revenue", height: 240 }),
        undefined,
      );
      assert.strictEqual(
        yield* sessions.takeHtmlRender(threadId, { ...revenue, html: "" }),
        undefined,
      );
      yield* sessions.recordHtmlRender(threadId, revenue, page("second"));
      assert.strictEqual(yield* sessions.takeHtmlRender(threadId, revenue), undefined);
      // Both pages stay kept for calls that tell them apart.
      assert.deepStrictEqual(
        yield* sessions.takeHtmlRender(threadId, revenue, page("first")),
        page("first"),
      );
      assert.deepStrictEqual(yield* sessions.takeHtmlRender(threadId, revenue), page("second"));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );
});
