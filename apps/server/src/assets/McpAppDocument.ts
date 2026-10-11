import { injectMcpAppCookieBootstrap, MCP_APP_MAX_HTML_BYTES } from "@t3tools/shared/mcpApp";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class McpAppDocumentReadError extends Schema.TaggedError<McpAppDocumentReadError>()(
  "McpAppDocumentReadError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read the MCP App document.";
  }
}

export class McpAppDocument extends Context.Service<
  McpAppDocument,
  {
    readonly read: (
      path: string,
    ) => Effect.Effect<
      { readonly _tag: "Document"; readonly html: string } | { readonly _tag: "TooLarge" },
      McpAppDocumentReadError
    >;
  }
>()("t3/assets/McpAppDocument") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  /** Read and prepare a saved MCP document without trusting its file length. */
  const read = Effect.fn("McpAppDocument.read")(function* (path: string) {
    // Saved captures also contain a bounded CSP meta tag added after the raw HTML limit.
    const limit = MCP_APP_MAX_HTML_BYTES + 128 * 1024;
    const chunks = yield* fileSystem.stream(path, { bytesToRead: limit + 1 }).pipe(
      Stream.runCollect,
      Effect.mapError((cause) => new McpAppDocumentReadError({ path, cause })),
    );
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    if (size > limit) return { _tag: "TooLarge" as const };
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      _tag: "Document" as const,
      html: injectMcpAppCookieBootstrap(new TextDecoder().decode(bytes)),
    };
  });

  return McpAppDocument.of({ read });
});

export const layer = Layer.effect(McpAppDocument, make);
