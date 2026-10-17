import { describe, expect, it } from "@effect/vitest";

import {
  MAX_REQUEST_HEADERS,
  isCloudflareAccessChallenge,
  requestHeadersError,
  requestHeadersForUrl,
  withCloudflareAccessServiceToken,
} from "./requestHeaders.ts";

describe("requestHeadersError", () => {
  it("accepts a Cloudflare Access service token", () => {
    expect(
      requestHeadersError([
        { name: "CF-Access-Client-Id", value: "abc.access" },
        { name: "CF-Access-Client-Secret", value: "secret value" },
      ]),
    ).toBeNull();
  });

  it.each(["", "Bad Name", "x:y", "naïve", "a\r\nb"])("rejects the header name %j", (name) => {
    expect(requestHeadersError([{ name, value: "v" }])).not.toBeNull();
  });

  it.each([
    "Host",
    "connection",
    "Cookie",
    "Authorization",
    "Content-Length",
    "Proxy-Foo",
    "Sec-WebSocket-Key",
  ])("rejects the forbidden header %s", (name) => {
    expect(requestHeadersError([{ name, value: "v" }])).not.toBeNull();
  });

  it("rejects values that could split a header, empty values, and duplicates", () => {
    expect(requestHeadersError([{ name: "X-A", value: "a\r\nX-B: b" }])).not.toBeNull();
    expect(requestHeadersError([{ name: "X-A", value: "" }])).not.toBeNull();
    expect(
      requestHeadersError([
        { name: "X-A", value: "1" },
        { name: "x-a", value: "2" },
      ]),
    ).not.toBeNull();
  });

  it("caps the number and length of headers", () => {
    const many = Array.from({ length: MAX_REQUEST_HEADERS + 1 }, (_, index) => ({
      name: `X-${index}`,
      value: "v",
    }));
    expect(requestHeadersError(many)).not.toBeNull();
    expect(requestHeadersError([{ name: "X-A", value: "v".repeat(5000) }])).not.toBeNull();
    expect(requestHeadersError([{ name: "X".repeat(200), value: "v" }])).not.toBeNull();
  });
});

describe("requestHeadersForUrl", () => {
  const headers = [{ name: "X-A", value: "a" }];
  const rules = [{ origin: "https://t3.example.test", headers }];

  it("attaches headers to HTTP and WebSocket URLs of the matching origin", () => {
    expect(requestHeadersForUrl(rules, "https://t3.example.test/api/pair?x=1")).toEqual(headers);
    expect(requestHeadersForUrl(rules, "wss://t3.example.test/ws")).toEqual(headers);
    expect(requestHeadersForUrl(rules, "https://t3.example.test:443/")).toEqual(headers);
  });

  it("never attaches headers to another origin", () => {
    for (const url of [
      "http://t3.example.test/",
      "ws://t3.example.test/ws",
      "https://t3.example.test:8443/",
      "https://other.example.test/",
      "https://t3.example.test.evil.test/",
      "https://evil.test/?u=https://t3.example.test",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(requestHeadersForUrl(rules, url)).toEqual([]);
    }
  });
});

describe("isCloudflareAccessChallenge", () => {
  it("detects a redirect to a Cloudflare Access login", () => {
    expect(
      isCloudflareAccessChallenge(302, {
        Location: ["https://team.cloudflareaccess.com/cdn-cgi/access/login/t3.example.test"],
      }),
    ).toBe(true);
  });

  it("detects a 401 or 403 that carries Cloudflare Access headers", () => {
    expect(isCloudflareAccessChallenge(403, { "cf-access-domain": "t3.example.test" })).toBe(true);
    expect(isCloudflareAccessChallenge(401, { "CF-Access-Aud": ["x"] })).toBe(true);
  });

  it("ignores other redirects and errors", () => {
    expect(isCloudflareAccessChallenge(302, { location: "https://example.test/login" })).toBe(
      false,
    );
    expect(
      isCloudflareAccessChallenge(302, { location: "https://cloudflareaccess.com.evil.test/" }),
    ).toBe(false);
    expect(isCloudflareAccessChallenge(403, { "content-type": "text/html" })).toBe(false);
    expect(isCloudflareAccessChallenge(200, { "cf-access-domain": "x" })).toBe(false);
  });
});

describe("withCloudflareAccessServiceToken", () => {
  it("replaces or removes only the service token headers", () => {
    const other = { name: "X-Other", value: "keep" };
    const headers = [
      { name: "cf-access-client-id", value: "old.access" },
      { name: "CF-Access-Client-Secret", value: "old" },
      other,
    ];
    expect(
      withCloudflareAccessServiceToken(headers, { clientId: "new.access", clientSecret: "new" }),
    ).toEqual([
      { name: "CF-Access-Client-Id", value: "new.access" },
      { name: "CF-Access-Client-Secret", value: "new" },
      other,
    ]);
    expect(withCloudflareAccessServiceToken(headers, null)).toEqual([other]);
  });
});
