/**
 * Per-thread state the T3 MCP server shares with the thread's provider
 * session. The session manager writes the T3 MCP credential the session
 * should expose to its agent before the session starts; adapters read it when
 * they build provider launch options. `html_render` keeps the pages it
 * published here for adapters whose agent reports a call without its result.
 *
 * @module provider-core/server/McpProviderSessions
 */
import type { ThreadId } from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

// Agents that report results never take their pages, so only the most recent
// pages are kept. A page is taken as soon as its call completes.
const MAX_KEPT_HTML_RENDERS = 64;

interface KeptHtmlRender {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly height: number;
  readonly reference: HtmlRenderReference;
}

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly read: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly clear: (threadId: ThreadId) => Effect.Effect<void>;
    /** Keeps a page `html_render` published with these arguments until a call takes it. */
    readonly recordHtmlRender: (
      threadId: ThreadId,
      input: { readonly title: string; readonly height: number },
      reference: HtmlRenderReference,
    ) => Effect.Effect<void>;
    /**
     * Removes and returns the oldest kept page the thread published with these
     * arguments, so each page goes to at most one call. A call that reported
     * its page takes that very page, so it never takes another call's.
     */
    readonly takeHtmlRender: (
      threadId: ThreadId,
      input: { readonly title?: unknown; readonly height?: unknown },
      reported?: HtmlRenderReference,
    ) => Effect.Effect<HtmlRenderReference | undefined>;
  }
>()("@t3tools/provider-core/server/McpProviderSessions") {}

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  const htmlRenders = yield* Ref.make<ReadonlyArray<KeptHtmlRender>>([]);
  return McpProviderSessions.of({
    set: (config) =>
      Ref.update(sessions, (current) => new Map(current).set(config.threadId, config)),
    read: (threadId) => Ref.get(sessions).pipe(Effect.map((current) => current.get(threadId))),
    clear: (threadId) =>
      Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }).pipe(
        Effect.andThen(
          Ref.update(htmlRenders, (kept) => kept.filter((page) => page.threadId !== threadId)),
        ),
      ),
    recordHtmlRender: (threadId, input, reference) =>
      Ref.update(htmlRenders, (kept) =>
        [...kept, { threadId, title: input.title, height: input.height, reference }].slice(
          -MAX_KEPT_HTML_RENDERS,
        ),
      ),
    takeHtmlRender: (threadId, input, reported) =>
      Ref.modify(htmlRenders, (kept) => {
        // Agents can report a numeric argument as a string, e.g. "240".
        const height =
          typeof input.height === "string" && input.height.trim() !== ""
            ? Number(input.height)
            : input.height;
        const index = kept.findIndex(
          (page) =>
            page.threadId === threadId &&
            (reported === undefined
              ? page.title === input.title && page.height === height
              : page.reference.attachmentId === reported.attachmentId),
        );
        return index === -1
          ? [undefined, kept]
          : [kept[index]!.reference, kept.filter((_, keptIndex) => keptIndex !== index)];
      }),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
