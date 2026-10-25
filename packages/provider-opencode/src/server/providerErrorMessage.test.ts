import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { readableProviderErrorMessage } from "./providerErrorMessage.ts";

const CLOUDFLARE_TUNNEL_PAGE = `<!doctype html><html><head><title>Cloudflare Tunnel error | llm.example.com | Cloudflare</title></head><body>error code: 1033</body></html>`;

describe("readableProviderErrorMessage", () => {
  // regression: OpenCode stores AI_APICallError as the message "<none>" when the
  // provider returns an HTML error page, and that placeholder was the thread failure.
  it.effect("uses the page title and HTTP status instead of <none>", () =>
    Effect.sync(() => {
      assert.equal(
        readableProviderErrorMessage({
          message: "<none>",
          statusCode: 530,
          responseBody: CLOUDFLARE_TUNNEL_PAGE,
        }),
        "Cloudflare Tunnel error | llm.example.com | Cloudflare (HTTP 530).",
      );
    }),
  );

  it.effect("keeps a message that already explains the failure", () =>
    Effect.sync(() => {
      assert.equal(
        readableProviderErrorMessage({
          message: "Rate limit exceeded: free-models-per-min.",
          statusCode: 429,
          responseBody: CLOUDFLARE_TUNNEL_PAGE,
        }),
        "Rate limit exceeded: free-models-per-min.",
      );
    }),
  );

  it.effect("replaces a bare <none> with an explicit sentence", () =>
    Effect.sync(() => {
      assert.equal(
        readableProviderErrorMessage({ message: "  <none>  " }),
        "The model provider failed the request and did not include an error message.",
      );
      assert.equal(
        readableProviderErrorMessage({ message: "<none>", statusCode: 530 }),
        "The model provider failed the request (HTTP 530).",
      );
    }),
  );
});
