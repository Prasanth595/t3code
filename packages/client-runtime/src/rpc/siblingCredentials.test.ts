import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  isSiblingOfPage,
  sendsSiblingCredentials,
  setCredentialedSiblingOrigins,
} from "./siblingCredentials.ts";

const page = { protocol: "https:", hostname: "t3-mac.example.com" };

describe("isSiblingOfPage", () => {
  it("matches https hosts that share the last two labels", () => {
    expect(isSiblingOfPage("https://t3-vps.example.com/api", page)).toBe(true);
    expect(isSiblingOfPage("https://EXAMPLE.com", page)).toBe(true);
  });

  it("rejects other domains, http, and pages without a location", () => {
    expect(isSiblingOfPage("https://t3-vps.example.org", page)).toBe(false);
    expect(isSiblingOfPage("https://t3-vps.notexample.com", page)).toBe(false);
    expect(isSiblingOfPage("http://t3-vps.example.com", page)).toBe(false);
    expect(isSiblingOfPage("https://t3-vps.example.com", { ...page, protocol: "http:" })).toBe(
      false,
    );
    expect(
      isSiblingOfPage("https://localhost", { protocol: "https:", hostname: "localhost" }),
    ).toBe(false);
    expect(isSiblingOfPage("https://t3-vps.example.com", undefined)).toBe(false);
    expect(isSiblingOfPage("not a url", page)).toBe(false);
  });
});

describe("sendsSiblingCredentials", () => {
  afterEach(() => setCredentialedSiblingOrigins([]));

  it("is off until the page server trusts the origin", () => {
    expect(sendsSiblingCredentials("https://t3-vps.example.com/api", page)).toBe(false);
  });

  it("sends credentials only to a trusted sibling", () => {
    setCredentialedSiblingOrigins(["https://t3-vps.example.com", "https://t3.other.com"]);
    expect(sendsSiblingCredentials("https://t3-vps.example.com/api/x", page)).toBe(true);
    expect(sendsSiblingCredentials("https://t3-win.example.com/api/x", page)).toBe(false);
    // Trusted but not a sibling of the page.
    expect(sendsSiblingCredentials("https://t3.other.com/api/x", page)).toBe(false);
  });
});
