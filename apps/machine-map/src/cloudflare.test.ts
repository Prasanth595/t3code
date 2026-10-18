import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CloudflareApi,
  CloudflareApiError,
  isMfaNotAllowed,
  organizationMfaUpdate,
} from "./cloudflare.ts";

const organization = {
  auth_domain: "team.cloudflareaccess.com",
  name: "team",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  session_duration: "24h",
  mfa_required_for_all_apps: false,
  login_design: { header_text: "Hi" },
  mfa_config: { session_duration: "10m", allowed_authenticators: [] },
};

describe("organizationMfaUpdate", () => {
  it("adds the approvals methods and keeps every field that PUT takes", () => {
    expect(organizationMfaUpdate(organization)).toEqual({
      auth_domain: "team.cloudflareaccess.com",
      name: "team",
      session_duration: "24h",
      mfa_required_for_all_apps: false,
      login_design: { header_text: "Hi" },
      mfa_config: {
        session_duration: "10m",
        allowed_authenticators: ["biometrics", "security_key"],
      },
    });
  });

  it("changes nothing when the organization allows a passkey already", () => {
    const allowed = { ...organization, mfa_config: { allowed_authenticators: ["biometrics"] } };
    expect(organizationMfaUpdate(allowed)).toBeNull();
  });
});

it("reads Cloudflare error 12130 as an organization without an allowed MFA method", () => {
  expect(isMfaNotAllowed(new CloudflareApiError(400, "refused", [12130]))).toBe(true);
  expect(isMfaNotAllowed(new CloudflareApiError(400, "refused", [10000]))).toBe(false);
});

describe("ensureAppLauncher", () => {
  afterEach(() => vi.unstubAllGlobals());

  const answer = (status: number, result: unknown) =>
    Response.json(
      {
        success: status < 400,
        errors: status < 400 ? [] : [{ code: 10000, message: "no" }],
        result,
      },
      { status },
    );

  const run = async (apps: ReadonlyArray<unknown>, postStatus = 200) => {
    const calls: Array<{ method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      calls.push({
        method,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return method === "GET" ? answer(200, apps) : answer(postStatus, {});
    });
    const outcome = await new CloudflareApi("token", "account").ensureAppLauncher(["o@x.com"]);
    return { outcome, posts: calls.filter((call) => call.method === "POST") };
  };

  it("skips an App Launcher that exists", async () => {
    expect(await run([{ type: "self_hosted" }, { type: "app_launcher" }])).toEqual({
      outcome: "present",
      posts: [],
    });
  });

  it("creates the App Launcher for the owner emails", async () => {
    expect(await run([{ type: "self_hosted" }])).toEqual({
      outcome: "present",
      posts: [
        {
          method: "POST",
          body: {
            type: "app_launcher",
            policies: [
              { name: "t3 owner", decision: "allow", include: [{ email: { email: "o@x.com" } }] },
            ],
          },
        },
      ],
    });
  });

  it("names the manual step when the token cannot create it", async () => {
    expect((await run([], 403)).outcome).toBe("cannotCreate");
  });
});
