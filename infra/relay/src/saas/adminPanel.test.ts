import { describe, expect, it } from "@effect/vitest";

import { clerkFrontendApiHost, renderAdminPanel } from "./adminPanel.ts";

describe("admin panel", () => {
  it("loads Clerk from the Frontend API the publishable key names", () => {
    const key = `pk_live_${btoa("clerk.mira.example$")}`;
    expect(clerkFrontendApiHost(key)).toBe("clerk.mira.example");
    expect(clerkFrontendApiHost("pk_live_not-base64!")).toBeNull();
    expect(renderAdminPanel({ clerkPublishableKey: key, clerkJwtTemplate: "t3-relay" })).toContain(
      'src="https://clerk.mira.example/npm/@clerk/clerk-js@5/dist/clerk.browser.js"',
    );
  });
});
