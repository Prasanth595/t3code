import { assert, describe, it } from "@effect/vitest";

import { classifyOpenCodeProviderFault } from "./failure.ts";

describe("classifyOpenCodeProviderFault", () => {
  it("classifies a v2 structured 429 as a usage limit", () => {
    const fault = classifyOpenCodeProviderFault({
      error: {
        type: "RateLimitError",
        message: "Rate limit exceeded. Please try again later.",
        status: 429,
        response: { body: "{}" },
      },
      message: "Rate limit exceeded. Please try again later.",
    });
    assert.equal(fault.class, "usage_limit");
    assert.equal(fault.retryable, true);
  });

  it("classifies a v1 tagged 429 as a usage limit", () => {
    const fault = classifyOpenCodeProviderFault({
      error: {
        name: "APIError",
        data: { message: "Rate limit exceeded.", statusCode: 429 },
      },
      message: "Rate limit exceeded.",
    });
    assert.equal(fault.class, "usage_limit");
    assert.equal(fault.retryable, true);
  });

  it.each([
    "Rate limit exceeded. Please try again later.",
    "Go usage limit exceeded",
    "Key limit exceeded (total limit)",
  ])("classifies %s as a usage limit", (message) => {
    const fault = classifyOpenCodeProviderFault({
      error: { type: "UnknownError", message },
      message,
    });
    assert.equal(fault.class, "usage_limit");
    assert.equal(fault.retryable, true);
  });

  it("reads a reset time from the v1 response headers", () => {
    const fault = classifyOpenCodeProviderFault({
      error: {
        name: "APIError",
        data: {
          message: "Rate limit exceeded.",
          statusCode: 429,
          responseHeaders: { "retry-after": "120" },
        },
      },
      message: "Rate limit exceeded.",
    });
    assert.equal(fault.class, "usage_limit");
    assert.notEqual(fault.resetAt, null);
    assert.isTrue(Date.parse(fault.resetAt!) > Date.now());
  });

  it("reads a reset time from the v2 response body", () => {
    const resetAt = new Date(Date.now() + 300_000).toISOString();
    const fault = classifyOpenCodeProviderFault({
      error: {
        type: "RateLimitError",
        message: "Rate limit exceeded.",
        status: 429,
        response: {
          body: JSON.stringify({ error: { metadata: { reset_at: resetAt } } }),
        },
      },
      message: "Rate limit exceeded.",
    });
    assert.equal(fault.class, "usage_limit");
    assert.equal(fault.resetAt, resetAt);
  });

  it.each(["1m", "90s", "2h"])(
    "reads a reset time from the %s duration header form",
    (duration) => {
      const fault = classifyOpenCodeProviderFault({
        error: {
          name: "APIError",
          data: {
            message: "Rate limit exceeded.",
            statusCode: 429,
            responseHeaders: { "x-ratelimit-reset-requests": duration },
          },
        },
        message: "Rate limit exceeded.",
      });
      assert.equal(fault.class, "usage_limit");
      assert.notEqual(fault.resetAt, null);
      assert.isTrue(Date.parse(fault.resetAt!) > Date.now());
    },
  );

  it.each([401, 403])("classifies %s as a permission error", (status) => {
    const fault = classifyOpenCodeProviderFault({
      error: { type: "APIError", message: "Invalid credential", status },
      message: "Invalid credential",
    });
    assert.equal(fault.class, "permission_error");
    assert.equal(fault.retryable, false);
  });

  it("classifies a provider auth error as a permission error", () => {
    const fault = classifyOpenCodeProviderFault({
      error: { type: "ProviderAuthError", message: "no key", status: 401 },
      message: "no key",
    });
    assert.equal(fault.class, "permission_error");
    assert.equal(fault.retryable, false);
  });

  it.each([400, 404, 409, 422])("classifies %s as a validation error", (status) => {
    const fault = classifyOpenCodeProviderFault({
      error: { type: "APIError", message: "This model is not available in your country", status },
      message: "This model is not available in your country",
    });
    assert.equal(fault.class, "validation_error");
    assert.equal(fault.retryable, false);
  });

  it("classifies a context overflow as a validation error", () => {
    const fault = classifyOpenCodeProviderFault({
      error: { type: "ContextOverflowError", message: "too long", status: 400 },
      message: "too long",
    });
    assert.equal(fault.class, "validation_error");
    assert.equal(fault.retryable, false);
  });

  it("classifies a server error as a retryable transport error", () => {
    const fault = classifyOpenCodeProviderFault({
      error: { type: "APIError", message: "upstream", status: 503 },
      message: "upstream",
    });
    assert.equal(fault.class, "transport_error");
    assert.equal(fault.retryable, true);
  });

  it("honours the v1 provider retryable flag", () => {
    const retryable = classifyOpenCodeProviderFault({
      error: { name: "APIError", data: { message: "upstream", isRetryable: true } },
      message: "upstream",
    });
    assert.equal(retryable.class, "transport_error");
    assert.equal(retryable.retryable, true);

    const permanent = classifyOpenCodeProviderFault({
      error: { name: "APIError", data: { message: "upstream", isRetryable: false } },
      message: "upstream",
    });
    assert.equal(permanent.class, "provider_error");
    assert.equal(permanent.retryable, false);
  });

  it("falls back to a provider error", () => {
    const fault = classifyOpenCodeProviderFault({
      error: { type: "UnknownError", message: "something broke" },
      message: "something broke",
    });
    assert.equal(fault.class, "provider_error");
    assert.equal(fault.retryable, null);
  });

  it("does not name a reset time the provider did not report", () => {
    const fault = classifyOpenCodeProviderFault({
      error: { type: "RateLimitError", message: "Rate limit exceeded.", status: 429 },
      message: "Rate limit exceeded.",
    });
    assert.equal(fault.resetAt, null);
  });
});
