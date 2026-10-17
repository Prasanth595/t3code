import type { ComposerContextRecord } from "@t3tools/contracts";

import { formatThreadAppLink, type ThreadAddress } from "./threadAddress.ts";

// Code comes first in the alternation so a marker inside a code span or fence stays as written.
// The marker shape is `formatComposerContextProviderMarker` for kind "thread".
const THREAD_MARKER_OUTSIDE_CODE =
  /(?<fence>(`{3,}|~{3,})[\s\S]*?(?:\2|$))|(?<span>(`+)[^\n]*?\4)|\[Thread: (?<label>[^;\]\n]*); ref=(?<ref>[A-Za-z0-9_-]{1,128})\]/g;

export type ThreadMarkerTargets = ReadonlyMap<string, ThreadAddress>;

function sameTargets(left: ThreadMarkerTargets, right: ThreadMarkerTargets): boolean {
  if (left.size !== right.size) return false;
  for (const [ref, target] of left) {
    const other = right.get(ref);
    if (other?.environmentId !== target.environmentId || other.threadId !== target.threadId) {
      return false;
    }
  }
  return true;
}

/**
 * Fork: the attached threads of a thread's user messages, by context id. The provider sees each
 * attached thread as a `[Thread: <title>; ref=<contextId>]` marker, and agents copy it into replies.
 * Streaming changes the messages on every token, so an unchanged result returns `previous` and
 * keeps its identity.
 */
export function threadMarkerTargets(
  messages: ReadonlyArray<{
    readonly context?: { readonly records: ReadonlyArray<ComposerContextRecord> } | undefined;
  }>,
  previous: ThreadMarkerTargets | null,
): ThreadMarkerTargets {
  const targets = new Map<string, ThreadAddress>();
  for (const message of messages) {
    for (const record of message.context?.records ?? []) {
      if (record.kind === "thread" && "threadId" in record) {
        targets.set(record.contextId, {
          environmentId: record.environmentId,
          threadId: record.threadId,
        });
      }
    }
  }
  return previous !== null && sameTargets(previous, targets) ? previous : targets;
}

/**
 * Fork: rewrites each thread marker whose ref names an attached thread into a thread app link, so
 * it renders like any other thread link. The ref is a context id, never parsed for a thread id. An
 * unknown ref stays text.
 */
export function linkThreadMarkers(markdown: string, targets: ThreadMarkerTargets): string {
  if (targets.size === 0 || !markdown.includes("ref=")) return markdown;
  return markdown.replace(THREAD_MARKER_OUTSIDE_CODE, (source, ...args) => {
    const groups = args.at(-1) as { label?: string; ref?: string };
    const target = groups.ref === undefined ? undefined : targets.get(groups.ref);
    if (target === undefined) return source;
    const label = groups.label?.replace(/[[\\]/g, " ").trim() || "Thread";
    return `[${label}](${formatThreadAppLink(target)})`;
  });
}
