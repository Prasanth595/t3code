import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isAdminEmail } from "./SaasApi.ts";
import { hasQuotaLeft, usagePeriod } from "./SaasAccounts.ts";

describe("SaaS accounts", () => {
  it("grants admin only to a listed email, ignoring case", () => {
    const admins = ["contact@andreimiron.ro"];
    expect(isAdminEmail("Contact@AndreiMiron.ro", admins)).toBe(true);
    expect(isAdminEmail("someone@andreimiron.ro", admins)).toBe(false);
    expect(isAdminEmail(null, admins)).toBe(false);
  });

  it("counts usage per UTC calendar month and stops at the plan limit", () => {
    expect(usagePeriod(DateTime.makeUnsafe("2026-10-31T23:59:59.000Z"))).toBe("2026-10");
    expect(usagePeriod(DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"))).toBe("2026-11");
    const plan = {
      id: "free",
      name: "Free",
      monthlyTokenLimit: 100,
      priceCents: 0,
      stripePriceId: null,
      isDefault: true,
      sortOrder: 0,
      agenticEnabled: false,
      dailyChatLimit: 0,
    };
    const usage = { period: "2026-10", inputTokens: 60, outputTokens: 39, requests: 2 };
    expect(hasQuotaLeft(plan, usage)).toBe(true);
    expect(hasQuotaLeft(plan, { ...usage, outputTokens: 40 })).toBe(false);
  });
});
