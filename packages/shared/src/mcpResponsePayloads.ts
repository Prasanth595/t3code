// MCP responses carry opaque JSON-RPC that callers relay verbatim.
// @effect-diagnostics preferSchemaOverJson:off
/**
 * Reads the JSON-RPC payloads of a response from an MCP streamable-HTTP
 * endpoint. Used on the ACP bridge fast path, so it imports only effect core.
 *
 * @module mcpResponsePayloads
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

async function* sseDataLines(response: Response): AsyncGenerator<string> {
  if (response.body === null) return;
  const decoder = new TextDecoder();
  // Offset-based window: the old code re-sliced (copied) the whole remainder
  // on every event, which is O(n^2) for large streams.
  let buffered = "";
  let start = 0;
  // One regex scan stops at the nearest separator of either style; two
  // indexOf calls would scan to the end for whichever style is absent.
  const separator = /\r\n\r\n|\n\n/g;
  let separatorLength = 0;
  const findSeparator = (from: number): number => {
    separator.lastIndex = from;
    const match = separator.exec(buffered);
    if (match === null) return -1;
    separatorLength = match[0].length;
    return match.index;
  };
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk as Uint8Array, { stream: true });
    let separatorIndex = findSeparator(start);
    while (separatorIndex !== -1) {
      const rawEvent = buffered.slice(start, separatorIndex);
      start = separatorIndex + separatorLength;
      const data = rawEvent
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (data.length > 0) yield data;
      separatorIndex = findSeparator(start);
    }
    // Compact the consumed prefix every chunk so appends and scans only ever
    // cover live tail bytes (never history). One tail copy per chunk replaces
    // the old per-event remainder copies.
    if (start > 0) {
      buffered = buffered.slice(start);
      start = 0;
    }
  }
}

export const discardResponseBody = (response: Response): Effect.Effect<void> =>
  Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve());

/**
 * Every JSON-RPC payload carried by a response, in arrival order: nothing for
 * notification acknowledgements, each SSE `data:` event as it streams in, or
 * the single JSON body.
 */
export function responsePayloads<E>(
  response: Response,
  onError: (cause: unknown) => E,
): Stream.Stream<unknown, E> {
  if (response.status === 202 || response.status === 204) {
    return Stream.unwrap(discardResponseBody(response).pipe(Effect.as(Stream.empty)));
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return Stream.fromAsyncIterable(sseDataLines(response), onError).pipe(
      Stream.mapEffect((data) => Effect.try({ try: () => JSON.parse(data), catch: onError })),
    );
  }
  return Stream.unwrap(
    Effect.tryPromise({ try: () => response.text(), catch: onError }).pipe(
      Effect.flatMap((text) =>
        text.trim().length === 0
          ? Effect.succeed(Stream.empty)
          : Effect.try({ try: () => JSON.parse(text) as unknown, catch: onError }).pipe(
              Effect.map((payload) => Stream.fromIterable([payload])),
            ),
      ),
    ),
  );
}
