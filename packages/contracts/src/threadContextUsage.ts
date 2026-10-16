import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  PositiveInt,
  ProviderThreadId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * What fills a thread's context window, read on demand from its live provider
 * session. Only providers that can measure their own context composition
 * report it; every other thread falls back to the totals on its provider turns.
 */
export const ThreadContextUsageInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * The provider thread the client is showing, normally the thread's active
   * one. A provider switch changes it, so a cached answer never outlives the
   * provider that gave it. Omitted means the active provider thread.
   */
  providerThreadId: Schema.optional(ProviderThreadId),
  /** The usage report the client last saw. Only keys the client cache. */
  revision: Schema.optional(Schema.String),
});
export type ThreadContextUsageInput = typeof ThreadContextUsageInput.Type;

/**
 * `used` rows occupy the window, `free` is what remains, `buffer` is reserved
 * for compaction, and `deferred` rows sit outside the window and are listed only
 * for awareness.
 */
export const ThreadContextUsageCategoryKind = Schema.Literals([
  "used",
  "free",
  "buffer",
  "deferred",
]);
export type ThreadContextUsageCategoryKind = typeof ThreadContextUsageCategoryKind.Type;

export const ThreadContextUsageCategory = Schema.Struct({
  /** The provider's own label, such as "Messages" or "MCP tools (deferred)". */
  name: TrimmedNonEmptyString,
  tokens: NonNegativeInt,
  kind: ThreadContextUsageCategoryKind,
});
export type ThreadContextUsageCategory = typeof ThreadContextUsageCategory.Type;

export const ThreadContextUsageGroupItem = Schema.Struct({
  name: TrimmedNonEmptyString,
  tokens: NonNegativeInt,
  /** Where the item comes from, such as an MCP server or a memory file's scope. */
  detail: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadContextUsageGroupItem = typeof ThreadContextUsageGroupItem.Type;

/** An itemized list behind one category, such as each MCP tool or memory file. */
export const ThreadContextUsageGroup = Schema.Struct({
  id: Schema.Literals(["mcp-tools", "memory-files", "skills", "agents"]),
  items: Schema.Array(ThreadContextUsageGroupItem),
});
export type ThreadContextUsageGroup = typeof ThreadContextUsageGroup.Type;

export const ThreadContextUsage = Schema.Struct({
  model: Schema.optional(TrimmedNonEmptyString),
  usedTokens: NonNegativeInt,
  maxTokens: Schema.optional(PositiveInt),
  categories: Schema.Array(ThreadContextUsageCategory),
  groups: Schema.Array(ThreadContextUsageGroup),
});
export type ThreadContextUsage = typeof ThreadContextUsage.Type;

/**
 * The categories of one breakdown, saved on the provider thread after a turn
 * when the user opts in, so the card can show them once the session stops.
 * Item lists stay on-demand to keep the thread payload small.
 */
export const ThreadContextBreakdown = Schema.Struct({
  model: Schema.optional(TrimmedNonEmptyString),
  usedTokens: NonNegativeInt,
  maxTokens: Schema.optional(PositiveInt),
  categories: Schema.Array(ThreadContextUsageCategory),
  /** ISO timestamp of the read; string so wire encoding is stable. */
  updatedAt: Schema.String,
});
export type ThreadContextBreakdown = typeof ThreadContextBreakdown.Type;

export const ThreadContextUsageErrorReason = Schema.Literals([
  "provider-unsupported",
  "session-stopped",
  "request-failed",
]);
export type ThreadContextUsageErrorReason = typeof ThreadContextUsageErrorReason.Type;

export class ThreadContextUsageError extends Schema.TaggedError<ThreadContextUsageError>()(
  "ThreadContextUsageError",
  {
    threadId: ThreadId,
    reason: ThreadContextUsageErrorReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "provider-unsupported":
        return "This thread's provider does not report what fills its context window.";
      case "session-stopped":
        return "The thread's provider session is not running.";
      case "request-failed":
        return "The provider could not report its context usage.";
    }
  }
}
