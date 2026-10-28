import { describe, expect, it } from "@effect/vitest";

import {
  mergeSessionSpendRefs,
  sessionRefsForProviderThreads,
  sessionSpendSourcesIncomplete,
} from "./usageSessionSpendInput.ts";
import { MAX_SESSION_SPEND_KEYS } from "./UsageService.ts";

function providerThread(
  driver: string,
  nativeId: string | null,
  strength: "strong" | "weak" | "none" = "strong",
) {
  return { driver, nativeThreadRef: nativeId === null ? null : { nativeId, strength } };
}

describe("sessionRefsForProviderThreads", () => {
  it("keeps joinable sessions and skips ids that are not usage sessions", () => {
    expect(
      sessionRefsForProviderThreads([
        providerThread("codex", "session-1"),
        providerThread("claudeAgent", "session-2"),
        providerThread("claudeAgent", "parent:task:task-1"),
        providerThread("cursor", "conversation-1"),
        providerThread("pi", "C:\\sessions\\pi.jsonl"),
        providerThread("grok", "session-3", "weak"),
        providerThread("opencode", null),
      ]),
    ).toEqual([
      { provider: "codex", sessionId: "session-1" },
      { provider: "claude", sessionId: "session-2" },
    ]);
  });
});

describe("mergeSessionSpendRefs", () => {
  it("counts a session once when a thread resolves a session the caller listed", () => {
    const merged = mergeSessionSpendRefs(
      [{ provider: "codex", sessionId: "shared" }],
      [
        { provider: "codex", sessionId: "shared" },
        { provider: "grok", sessionId: "other" },
      ],
    );
    expect(merged).toEqual({
      sessions: [
        { provider: "codex", sessionId: "shared" },
        { provider: "grok", sessionId: "other" },
      ],
      truncatedSessions: 0,
    });
  });

  it("reports sessions dropped past the per-read cap", () => {
    const resolved = Array.from({ length: MAX_SESSION_SPEND_KEYS + 3 }, (_, index) => ({
      provider: "codex" as const,
      sessionId: `session-${index}`,
    }));
    const merged = mergeSessionSpendRefs([], resolved);
    expect(merged.sessions).toHaveLength(MAX_SESSION_SPEND_KEYS);
    expect(merged.truncatedSessions).toBe(3);
  });
});

describe("sessionSpendSourcesIncomplete", () => {
  const source = (provider: string, status: "ok" | "missing" | "partial" | "failed") => ({
    status,
    fingerprint: { provider },
  });

  it("flags a partial or failed source even when it returned no rows", () => {
    expect(
      sessionSpendSourcesIncomplete(
        [source("codex", "ok"), source("grok", "failed")],
        [{ provider: "grok", sessionId: "session-1" }],
      ),
    ).toBe(true);
    expect(
      sessionSpendSourcesIncomplete(
        [source("grok", "partial")],
        [
          { provider: "grok", sessionId: "session-1" },
          { provider: "codex", sessionId: "session-2" },
        ],
      ),
    ).toBe(true);
  });

  it("stays complete when unrelated providers are partial", () => {
    expect(
      sessionSpendSourcesIncomplete(
        [source("grok", "failed"), source("codex", "ok")],
        [{ provider: "codex", sessionId: "session-1" }],
      ),
    ).toBe(false);
    expect(
      sessionSpendSourcesIncomplete(
        [source("codex", "missing")],
        [{ provider: "codex", sessionId: "session-1" }],
      ),
    ).toBe(false);
  });
});
