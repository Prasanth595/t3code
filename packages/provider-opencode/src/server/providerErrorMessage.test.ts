import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { readableProviderErrorMessage } from "./providerErrorMessage.ts";

describe("readableProviderErrorMessage", () => {
  // regression: OpenCode stores "<none>" when the provider returns an HTML error page.
  it.effect("replaces <none> with the page title and HTTP status", () =>
    Effect.sync(() => {
      assert.equal(
        readableProviderErrorMessage({
          message: "<none>",
          statusCode: 530,
          responseBody: "<title>Cloudflare Tunnel error | llm.example.com | Cloudflare</title>",
        }),
        "Cloudflare Tunnel error | llm.example.com | Cloudflare (HTTP 530).",
      );
      assert.equal(
        readableProviderErrorMessage({ message: "Rate limit exceeded." }),
        "Rate limit exceeded.",
      );
    }),
  );
});
