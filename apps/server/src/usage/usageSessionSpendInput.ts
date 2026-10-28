import type { UsageSessionRef } from "@t3tools/contracts";
import { joinableUsageSessionRef, uniqueUsageSessionRefs } from "@t3tools/shared/usageSessionRefs";

import { MAX_SESSION_SPEND_KEYS } from "./UsageService.ts";

export interface ProviderThreadSessionSource {
  readonly driver: string;
  readonly nativeThreadRef: {
    readonly nativeId: string | null;
    readonly strength: "strong" | "weak" | "none";
  } | null;
}

/** Provider sessions a T3 thread's provider threads can be priced by. */
export function sessionRefsForProviderThreads(
  providerThreads: readonly ProviderThreadSessionSource[],
): UsageSessionRef[] {
  const refs: UsageSessionRef[] = [];
  for (const providerThread of providerThreads) {
    const ref = joinableUsageSessionRef(
      providerThread.driver,
      providerThread.nativeThreadRef?.nativeId ?? null,
      providerThread.nativeThreadRef?.strength ?? "none",
    );
    if (ref !== null) refs.push(ref);
  }
  return refs;
}

/**
 * Explicit sessions first, then thread-resolved ones. One read prices at most
 * `MAX_SESSION_SPEND_KEYS` sessions, so the caller learns what it dropped instead of quietly
 * showing a short total.
 */
export function mergeSessionSpendRefs(
  explicit: readonly UsageSessionRef[],
  resolved: readonly UsageSessionRef[],
): { readonly sessions: readonly UsageSessionRef[]; readonly truncatedSessions: number } {
  const unique = uniqueUsageSessionRefs([...explicit, ...resolved]);
  const sessions = unique.slice(0, MAX_SESSION_SPEND_KEYS);
  return { sessions, truncatedSessions: unique.length - sessions.length };
}

/**
 * True when a source that would have covered one of the requested sessions is partial or failed.
 * Matching on the request rather than on returned rows keeps a provider whose scan failed, and so
 * returned nothing, counted as incomplete instead of looking like a complete total.
 */
export function sessionSpendSourcesIncomplete(
  sources: readonly {
    readonly status: "ok" | "missing" | "partial" | "failed";
    readonly fingerprint: { readonly provider: string };
  }[],
  sessions: readonly UsageSessionRef[],
): boolean {
  const wanted = new Set<string>(sessions.map((session) => session.provider));
  return sources.some(
    (source) =>
      wanted.has(source.fingerprint.provider) &&
      (source.status === "partial" || source.status === "failed"),
  );
}
