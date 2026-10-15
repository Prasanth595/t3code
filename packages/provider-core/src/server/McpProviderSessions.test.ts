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

describe("McpProviderSessions html_render pages", () => {
  it.effect("matches a height the agent reports as a numeric string", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.recordHtmlRender(threadId, { title: "Revenue", height: 240 }, page("first"));

      assert.strictEqual(
        yield* sessions.takeHtmlRender(threadId, { title: "Revenue", height: "240px" }),
        undefined,
      );
      assert.strictEqual(
        yield* sessions.takeHtmlRender(threadId, { title: "Revenue", height: "" }),
        undefined,
      );
      assert.deepStrictEqual(
        yield* sessions.takeHtmlRender(threadId, { title: "Revenue", height: " 240 " }),
        page("first"),
      );
      // Each page goes to one call.
      assert.strictEqual(
        yield* sessions.takeHtmlRender(threadId, { title: "Revenue", height: 240 }),
        undefined,
      );
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );
});
