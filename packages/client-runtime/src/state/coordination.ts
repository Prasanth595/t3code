import {
  canReplyToCoordination,
  WS_METHODS,
  type CoordinationEntry,
  type CoordinationKind,
  type CoordinationSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function coordinationMentionQuery(text: string, caret: number) {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@([^@\n]*)$/.exec(before);
  if (!match) return null;
  return { query: match[1] ?? "", start: before.lastIndexOf("@"), end: caret };
}

export function hasCoordinationMention(text: string) {
  return /(?:^|\s)@/.test(text);
}

export function coordinationPostContent(input: {
  text: string;
  kind: CoordinationKind;
  targetThreadId?: ThreadId;
  reply?: CoordinationEntry;
}) {
  const text = input.text.trim();
  return {
    text,
    kind: input.reply ? ("update" as const) : input.kind,
    topic: input.reply?.topic ?? text.split(/\r?\n/, 1)[0]!.slice(0, 160),
    ...(input.reply
      ? { replyToId: input.reply.id }
      : input.targetThreadId
        ? { targetThreadId: input.targetThreadId }
        : {}),
  };
}

export function createCoordinationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    read: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:coordination:read",
      tag: WS_METHODS.coordinationRead,
    }),
    loadOlder: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:coordination:load-older",
      tag: WS_METHODS.coordinationRead,
    }),
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:coordination:snapshot",
      tag: WS_METHODS.coordinationSubscribe,
      idleTtlMs: 0,
    }),
    post: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:coordination:post",
      tag: WS_METHODS.coordinationPost,
    }),
    resolve: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:coordination:resolve",
      tag: WS_METHODS.coordinationResolve,
    }),
    handle: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:coordination:handle",
      tag: WS_METHODS.coordinationHandle,
    }),
    preferences: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:coordination:preferences",
      tag: WS_METHODS.coordinationPreferences,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.threadId]),
      },
    }),
  };
}

/** Keep each conversation together, including replies whose parent is outside the page. */
export function coordinationTopics(entries: ReadonlyArray<CoordinationEntry>, threadId: ThreadId) {
  const topics = new Map<string, CoordinationEntry[]>();
  for (const entry of entries) {
    const topic = topics.get(entry.topic);
    if (topic) topic.push(entry);
    else topics.set(entry.topic, [entry]);
  }
  return Array.from(topics, ([topic, items]) => {
    const roots = new Map(
      items.filter((entry) => entry.replyToId === null).map((entry) => [entry.id, entry]),
    );
    const children = new Map<string, CoordinationEntry[]>();
    const ordered = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const entry of ordered) {
      if (entry.replyToId !== null) {
        const replies = children.get(entry.replyToId) ?? [];
        replies.push(entry);
        children.set(entry.replyToId, replies);
      }
    }
    const rows: Array<{ entry: CoordinationEntry; depth: number; canReply: boolean }> = [];
    // The service stores every reply against its discussion root. A paged-out
    // root remains visible as an orphan, but cannot offer actions without its routing.
    for (const entry of ordered) {
      if (entry.replyToId !== null) {
        if (!roots.has(entry.replyToId)) rows.push({ entry, depth: 1, canReply: false });
        continue;
      }
      const canReply = entry.status === "open" && canReplyToCoordination(entry, threadId);
      rows.push({ entry, depth: 0, canReply });
      for (const reply of children.get(entry.id) ?? [])
        rows.push({ entry: reply, depth: 1, canReply: canReply && reply.status === "open" });
    }
    return { topic, revision: Math.max(...items.map((entry) => entry.revision)), rows };
  }).sort((a, b) => b.revision - a.revision);
}

export function coordinationPresenceLabel(
  status: CoordinationSnapshot["threads"][number]["status"],
) {
  switch (status) {
    case "working":
      return "Working";
    case "waiting_for_agent":
      return "Waiting for agent";
    case "waiting_for_user":
      return "Waiting for you";
    case "done":
      return "Done";
    case "idle":
      return "Idle";
  }
}

export function mergeCoordinationEntries(
  older: ReadonlyArray<CoordinationEntry>,
  current: ReadonlyArray<CoordinationEntry>,
) {
  const entries = new Map(older.map((entry) => [entry.id, entry]));
  for (const entry of current) {
    const previous = entries.get(entry.id);
    if (!previous || entry.revision >= previous.revision) entries.set(entry.id, entry);
  }
  return [...entries.values()];
}
