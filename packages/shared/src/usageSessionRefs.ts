import type { UsageProviderKind, UsageSessionRef } from "@t3tools/contracts";

/**
 * Providers whose native thread id is also the usage session id. Cursor's conversation id is
 * not the agent id, Antigravity's native id is unconfirmed, and Pi often stores a file path.
 */
const JOINABLE_DRIVERS: Readonly<Record<string, UsageProviderKind>> = {
  claudeAgent: "claude",
  codex: "codex",
  grok: "grok",
  opencode: "opencode",
  muse: "muse",
  pi: "pi",
};

export function joinableUsageSessionRef(
  driver: string,
  nativeId: string | null | undefined,
  strength: "strong" | "weak" | "none" | null = "strong",
): UsageSessionRef | null {
  if (strength !== "strong") return null;
  const provider = JOINABLE_DRIVERS[driver];
  if (provider === undefined || nativeId === null || nativeId === undefined || nativeId === "") {
    return null;
  }
  // An ACP `:task:` key is not the billable session.
  if (nativeId.includes(":task:")) return null;
  if (provider === "pi" && (nativeId.includes("/") || nativeId.includes("\\"))) return null;
  return { provider, sessionId: nativeId };
}

export function usageSessionKey(ref: Pick<UsageSessionRef, "provider" | "sessionId">): string {
  return `${ref.provider}\u0000${ref.sessionId}`;
}

export function uniqueUsageSessionRefs(refs: readonly UsageSessionRef[]): UsageSessionRef[] {
  const seen = new Set<string>();
  const unique: UsageSessionRef[] = [];
  for (const ref of refs) {
    const key = usageSessionKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}
