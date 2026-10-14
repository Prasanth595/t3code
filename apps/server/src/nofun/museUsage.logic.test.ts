import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  museChildEnvironment,
  museSourceId,
  museSourceSnapshot,
  museUsageWindows,
  MuseStoredObservation,
  restoreMuseStoredObservation,
  sanitizeMuseFailure,
  type MuseAccount,
  type MuseAccountState,
  type MuseStoredObservation as MuseStoredObservationType,
  type MuseSubscriptionUsage,
} from "./museUsage.logic.ts";

const decodeStoredObservation = Schema.decodeUnknownOption(MuseStoredObservation);

const usage = (window: number, weekly: number): MuseSubscriptionUsage => ({
  window: { usedPercent: window, resetsAtMs: 1_000_000, windowDurationMins: 300 },
  weekly: { usedPercent: weekly, resetsAtMs: 9_000_000 },
  observedAtMs: 500,
});

const account = (id: string, expectedEmail?: string): MuseAccount => ({
  id,
  label: id,
  ...(expectedEmail ? { expectedEmail } : {}),
});

const state = (
  id: string,
  reading: MuseSubscriptionUsage | null,
  extra: Partial<MuseAccountState> = {},
): MuseAccountState => ({
  account: account(id),
  signedInAs: null,
  usage: reading,
  error: null,
  checkedAtMs: 500,
  ...extra,
});

describe("museChildEnvironment", () => {
  it("refuses the route when META_API_KEY is set instead of stripping it", () => {
    expect(museChildEnvironment(account("a"), { META_API_KEY: "x" })).toHaveProperty("refused");
  });

  it("drops inherited account routing and applies the account's own roots", () => {
    const result = museChildEnvironment(
      { ...account("a"), configHome: "/c", dataHome: "/d" },
      { PATH: "/bin", MUSE_AUTH_PATH: "/other/auth.json", TBH_CREDENTIAL_BACKEND: "file" },
    );
    expect(result).toEqual({ env: { PATH: "/bin", XDG_CONFIG_HOME: "/c", XDG_DATA_HOME: "/d" } });
  });
});

describe("museUsageWindows", () => {
  it("preserves fractional usage so a nearly spent pool is not exhausted by rounding", () => {
    expect(museUsageWindows(usage(99.6, 2))[0]?.usedPercent).toBe(99.6);
  });
  it("caps over-quota percentages at the contract's 100", () => {
    const [session, weekly] = museUsageWindows(usage(130, 2));
    expect(session).toMatchObject({ id: "five_hour", kind: "session", usedPercent: 100 });
    expect(session?.resetsAt).toBe("1970-01-01T00:16:40.000Z");
    expect(weekly).toMatchObject({ kind: "weekly", usedPercent: 2 });
  });
});

describe("museSourceSnapshot", () => {
  it("keeps a failing subscription visible with its error", () => {
    const snapshot = museSourceSnapshot({ ...state("b", null), error: "Not logged in." });
    expect(snapshot).toMatchObject({ id: "muse:b", kind: "muse", accounts: [] });
    expect(snapshot.error).toBe("Not logged in.");
  });

  it("keeps the old successful age when a later observation fails", () => {
    const snapshot = museSourceSnapshot({
      ...state("b", usage(40, 10)),
      error: "The passive read failed.",
      checkedAtMs: 9_000,
      lastRefreshAttemptAtMs: 9_000,
      lastSuccessfulObservationAtMs: 500,
    });
    expect(snapshot.checkedAt).toBe("1970-01-01T00:00:00.500Z");
    expect(snapshot.error).toBe("The passive read failed.");
    expect(snapshot.accounts[0]?.usageLimits.windows).toMatchObject([
      { id: "five_hour", usedPercent: 40 },
      { id: "weekly", usedPercent: 10 },
    ]);
  });
});

describe("museSourceId", () => {
  it("binds one stable source id per account id", () => {
    expect(museSourceId("personal")).toBe("muse:personal");
  });
});

describe("MuseStoredObservation", () => {
  const stored = (extra: Partial<MuseStoredObservationType> = {}): MuseStoredObservationType => ({
    version: 1,
    accountId: "personal",
    sourceId: "muse:personal",
    usage: usage(40, 10),
    recordedAtMs: 600,
    ...extra,
  });

  it("decodes a sanitized observation without launchers, roots, or credentials", () => {
    const decoded = decodeStoredObservation(stored());
    expect(Option.isSome(decoded)).toBe(true);
  });

  it("rejects a stored observation missing its account binding", () => {
    const { accountId: _dropped, ...rest } = stored();
    void _dropped;
    expect(Option.isNone(decodeStoredObservation(rest))).toBe(true);
  });
});

describe("restoreMuseStoredObservation", () => {
  const stored = (extra: Partial<MuseStoredObservationType> = {}): MuseStoredObservationType => ({
    version: 1,
    accountId: "personal",
    sourceId: "muse:personal",
    usage: usage(40, 10),
    recordedAtMs: 600,
    ...extra,
  });

  it("accepts a stored observation bound to the configured account", () => {
    const result = restoreMuseStoredObservation(
      stored({ signedInAs: "you@example.com", cost: "passive" }),
      account("personal"),
    );
    expect(result).toMatchObject({
      _tag: "Accepted",
      signedInAs: "you@example.com",
      cost: "passive",
    });
  });

  it("rejects a stored observation filed under another account id", () => {
    expect(
      restoreMuseStoredObservation(stored({ accountId: "other" }), account("personal")),
    ).toEqual({ _tag: "Rejected", reason: "account_mismatch" });
  });

  it("rejects a stored observation with a mismatched source id", () => {
    expect(
      restoreMuseStoredObservation(stored({ sourceId: "muse:other" }), account("personal")),
    ).toEqual({ _tag: "Rejected", reason: "source_mismatch" });
  });

  it("rejects a stored login that no longer matches the expected login", () => {
    expect(
      restoreMuseStoredObservation(
        stored({ signedInAs: "someone-else@example.com" }),
        account("personal", "you@example.com"),
      ),
    ).toEqual({ _tag: "Rejected", reason: "identity_mismatch" });
  });

  it("accepts when neither side pins a login, defaulting cost to unknown", () => {
    expect(restoreMuseStoredObservation(stored(), account("personal"))).toMatchObject({
      _tag: "Accepted",
      signedInAs: null,
      cost: "unknown",
    });
  });

  it("rejects when an expected login is configured but the stored login is absent", () => {
    expect(restoreMuseStoredObservation(stored(), account("personal", "you@example.com"))).toEqual({
      _tag: "Rejected",
      reason: "identity_mismatch",
    });
    expect(
      restoreMuseStoredObservation(
        stored({ signedInAs: "  " }),
        account("personal", "you@example.com"),
      ),
    ).toEqual({ _tag: "Rejected", reason: "identity_mismatch" });
  });

  it("accepts a positively matching stored login regardless of case", () => {
    expect(
      restoreMuseStoredObservation(
        stored({ signedInAs: "You@Example.com" }),
        account("personal", "you@example.com"),
      ),
    ).toMatchObject({ _tag: "Accepted", signedInAs: "You@Example.com" });
  });
});

describe("sanitizeMuseFailure", () => {
  it("returns the fixed categorical message for every cause shape", () => {
    expect(sanitizeMuseFailure("")).toBe("The Muse observation failed.");
    expect(sanitizeMuseFailure("   ")).toBe("The Muse observation failed.");
    expect(sanitizeMuseFailure(42)).toBe("The Muse observation failed.");
    expect(sanitizeMuseFailure(null)).toBe("The Muse observation failed.");
    expect(sanitizeMuseFailure(new Error("read /tmp/x/muse.json\nfailed"))).toBe(
      "The Muse observation failed.",
    );
    expect(sanitizeMuseFailure("x".repeat(500))).toBe("The Muse observation failed.");
  });

  it("never leaks a secret canary, path, or payload from the cause", () => {
    const result = sanitizeMuseFailure(
      new Error("SECRET_CANARY_123 token=hunter2 at /home/user/.muse/auth.json"),
    );
    expect(result).not.toContain("SECRET_CANARY_123");
    expect(result).not.toContain("hunter2");
    expect(result).not.toContain("/home/user");
    expect(result).not.toContain("auth.json");
  });
});
