import type { UsageCategoryCost, UsageSessionRef, UsageSessionSpend } from "@t3tools/contracts";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { usageTotalTokens } from "@t3tools/shared/usageMerge";
import {
  joinableUsageSessionRef,
  uniqueUsageSessionRefs,
  usageSessionKey,
} from "@t3tools/shared/usageSessionRefs";

export { usageTotalTokens };

/** Matches the usage scan retention in UsageService. */
export const THREAD_SPEND_WINDOW_DAYS = 92;

/** Kept for callers that name the provider-side join rule. */
export const joinableSessionRef = joinableUsageSessionRef;
export const sessionKey = usageSessionKey;

export interface SpendThreadNode {
  readonly id: string;
  readonly title: string;
  readonly environmentId: string;
  readonly deleted: boolean;
  readonly relationshipToParent: "fork" | "subagent" | null;
  readonly parentThreadId: string | null;
  readonly activeProviderThreadId: string | null;
  /** null until that thread's provider sessions are loaded. */
  readonly sessions: readonly UsageSessionRef[] | null;
}

export interface SpendMoney {
  readonly tokens: number;
  readonly costUsd: number;
  /** Every record is unpriced, so there is no dollar figure at all. */
  readonly unpriced: boolean;
  /** Records without a price; the dollar figure is a lower bound while this is above zero. */
  readonly unpricedRecords: number;
  readonly category: UsageCategoryCost | null;
}

/**
 * What a thread's spend read can say. `empty` still carries scan state: no priced rows yet is not
 * the same as no usage, so a first or partial scan must not read as a settled answer.
 */
export type ThreadSpendView =
  | { readonly kind: "empty"; readonly partial: boolean; readonly refreshing: boolean }
  | { readonly kind: "unsplit"; readonly parentTitle: string | null }
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly own: SpendMoney;
      readonly includingSubagents: SpendMoney | null;
      readonly subagentsNotIncluded: boolean;
      readonly parentTitle: string | null;
      readonly isSubagent: boolean;
      readonly refreshing: boolean;
      /** A usage source was partial, so every total here is a lower bound. */
      readonly partial: boolean;
      readonly sinceDay: string | null;
      readonly untilDay: string | null;
    };

export type ProjectSpendView =
  | { readonly kind: "empty"; readonly partial: boolean; readonly refreshing: boolean }
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly money: SpendMoney;
      /** Threads the read covered. */
      readonly threads: number;
      /** A source was partial or the read dropped sessions, so totals are a lower bound. */
      readonly partial: boolean;
      readonly refreshing: boolean;
      readonly sinceDay: string | null;
      readonly untilDay: string | null;
    };

export function descendantSubagentIds(
  rootId: string,
  threads: readonly SpendThreadNode[],
): readonly string[] {
  const children = new Map<string, string[]>();
  for (const thread of threads) {
    if (thread.deleted || thread.relationshipToParent !== "subagent") continue;
    if (thread.parentThreadId === null) continue;
    const list = children.get(thread.parentThreadId);
    if (list === undefined) children.set(thread.parentThreadId, [thread.id]);
    else list.push(thread.id);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [...(children.get(rootId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const child of children.get(id) ?? []) stack.push(child);
  }
  return out;
}

/**
 * Sums deduped session rows. The server already dedupes a thread-resolved read, but a caller can
 * pass explicit sessions alongside thread ids, so the same session can arrive twice.
 */
function sumRows(rows: readonly UsageSessionSpend[]): {
  readonly matched: number;
  readonly money: SpendMoney;
} {
  const seen = new Set<string>();
  let tokens = 0;
  let costUsd = 0;
  let records = 0;
  let unpricedRecords = 0;
  let category: UsageCategoryCost | null = null;
  let categoryComplete = true;
  let matched = 0;
  for (const row of rows) {
    const key = usageSessionKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    matched += 1;
    tokens += usageTotalTokens(row.totals);
    costUsd += row.costUsd;
    records += row.records;
    unpricedRecords += row.unpricedRecords;
    const add = row.categoryCostUsd;
    if (add === undefined) {
      categoryComplete = false;
      continue;
    }
    category =
      category === null
        ? add
        : {
            input: category.input + add.input,
            cacheRead: category.cacheRead + add.cacheRead,
            cacheWrite: category.cacheWrite + add.cacheWrite,
            output: category.output + add.output,
          };
  }
  if (!categoryComplete) category = null;
  return {
    matched,
    money: {
      tokens,
      costUsd,
      unpriced: records > 0 && unpricedRecords === records,
      unpricedRecords,
      category,
    },
  };
}

function sumRefs(
  refs: readonly UsageSessionRef[],
  priced: ReadonlyMap<string, UsageSessionSpend>,
): { readonly matched: number; readonly money: SpendMoney } {
  const rows: UsageSessionSpend[] = [];
  for (const ref of uniqueUsageSessionRefs(refs)) {
    const row = priced.get(usageSessionKey(ref));
    if (row !== undefined) rows.push(row);
  }
  return sumRows(rows);
}

function pricedMap(rows: readonly UsageSessionSpend[]): Map<string, UsageSessionSpend> {
  return new Map(rows.map((row) => [usageSessionKey(row), row]));
}

export function buildThreadSpendView(input: {
  readonly thread: SpendThreadNode | null;
  readonly threads: readonly SpendThreadNode[];
  readonly priced: readonly UsageSessionSpend[] | null;
  readonly refreshing: boolean;
  readonly partial: boolean;
  readonly sinceDay: string | null;
  readonly untilDay: string | null;
}): ThreadSpendView {
  const thread = input.thread;
  if (thread === null || thread.deleted)
    return { kind: "empty", partial: false, refreshing: false };

  const parent =
    thread.parentThreadId === null
      ? null
      : (input.threads.find((candidate) => candidate.id === thread.parentThreadId) ?? null);
  const parentTitle = parent?.title ?? null;
  const isSubagent = thread.relationshipToParent === "subagent";
  if (
    isSubagent &&
    thread.sessions !== null &&
    thread.sessions.length === 0 &&
    thread.activeProviderThreadId === null
  ) {
    return { kind: "unsplit", parentTitle };
  }
  if (thread.sessions === null) return { kind: "loading" };
  if (thread.sessions.length === 0)
    return { kind: "empty", partial: input.partial, refreshing: input.refreshing };
  if (input.priced === null) return { kind: "loading" };

  const priced = pricedMap(input.priced);
  const own = sumRefs(thread.sessions, priced);
  if (own.matched === 0)
    return { kind: "empty", partial: input.partial, refreshing: input.refreshing };

  const byId = new Map(input.threads.map((candidate) => [candidate.id, candidate]));
  const descendants = descendantSubagentIds(thread.id, input.threads);
  let subagentsNotIncluded = false;
  let includingSubagents: SpendMoney | null = null;
  if (descendants.length > 0) {
    const childRefs: UsageSessionRef[] = [];
    for (const id of descendants) {
      const child = byId.get(id);
      if (child === undefined || child.sessions === null) {
        subagentsNotIncluded = true;
        continue;
      }
      // A provider thread with no joinable usage id is not a zero-cost child.
      if (child.sessions.length === 0 && child.activeProviderThreadId !== null) {
        subagentsNotIncluded = true;
        continue;
      }
      childRefs.push(...child.sessions);
    }
    if (!subagentsNotIncluded) {
      includingSubagents = sumRefs([...thread.sessions, ...childRefs], priced).money;
    }
  }

  return {
    kind: "ready",
    own: own.money,
    includingSubagents,
    subagentsNotIncluded,
    parentTitle,
    isSubagent,
    refreshing: input.refreshing,
    partial: input.partial,
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
  };
}

export function buildProjectSpendView(input: {
  readonly priced: readonly UsageSessionSpend[] | null;
  readonly threads: number;
  readonly partial: boolean;
  readonly refreshing: boolean;
  readonly sinceDay: string | null;
  readonly untilDay: string | null;
}): ProjectSpendView {
  if (input.priced === null) return { kind: "loading" };
  const summed = sumRows(input.priced);
  if (summed.matched === 0)
    return { kind: "empty", partial: input.partial, refreshing: input.refreshing };
  return {
    kind: "ready",
    money: summed.money,
    threads: input.threads,
    partial: input.partial,
    refreshing: input.refreshing,
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
  };
}

export function formatSpendMoney(money: SpendMoney): {
  readonly dollars: string;
  readonly tokens: string;
} {
  return {
    dollars: money.unpriced ? "unpriced" : formatUsd(money.costUsd),
    tokens: formatTokens(money.tokens),
  };
}

/** True when only part of the usage could be counted, so the total is a lower bound. */
export function spendIsPartial(money: SpendMoney, partial: boolean): boolean {
  return partial || (money.unpricedRecords > 0 && !money.unpriced);
}

export function formatSpendLabel(money: SpendMoney, partial: boolean): string {
  const formatted = formatSpendMoney(money);
  // A missing dollar figure is already its own signal; do not stack a lower-bound marker on it.
  const prefix = !money.unpriced && spendIsPartial(money, partial) ? "≥ " : "";
  return `${prefix}${formatted.dollars} · ${formatted.tokens}`;
}

/**
 * True when the read is anything less than the whole picture for the scope it was asked about:
 * an incomplete source, sessions the server dropped at the cap, or threads it could not resolve.
 * The server decides the first case because only it knows which sessions a request reaches.
 */
export function spendResultIncomplete(
  result:
    | {
        readonly incomplete?: boolean | undefined;
        readonly truncatedSessions?: number | undefined;
        readonly unresolvedThreads?: number | undefined;
      }
    | null
    | undefined,
): boolean {
  if (result == null) return false;
  return (
    result.incomplete === true ||
    (result.truncatedSessions ?? 0) > 0 ||
    (result.unresolvedThreads ?? 0) > 0
  );
}

/**
 * Identity for a loaded session list. Distinguishes "not loaded yet" (null) from "loaded, no
 * joinable sessions" ([]), so a subagent that resolves to nothing is not left looking unloaded.
 */
export function sessionListKey(sessions: readonly UsageSessionRef[] | null | undefined): string {
  if (sessions == null) return "\u0000unloaded";
  return sessions.map((ref) => usageSessionKey(ref)).join("\n");
}

export function collectSessionRefs(threads: readonly SpendThreadNode[]): UsageSessionRef[] {
  return uniqueUsageSessionRefs(
    threads.flatMap((thread) =>
      thread.deleted || thread.sessions === null ? [] : thread.sessions,
    ),
  );
}
