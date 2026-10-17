import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { promptLinkAppPath } from "./promptLinks.ts";

export interface ThreadAddress {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId?: MessageId;
}

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const decodeMessageId = Schema.decodeUnknownOption(MessageId);

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Fork: the thread that a link names with its environment: a web address of a T3 server,
 * `https://<host>/<environmentId>/<threadId>`, or the app link `t3code://threads/<environmentId>/<threadId>`.
 * Both may carry `?message=<messageId>`. The host does not matter: the environment id is the
 * identity, so a client checks it against the environments it knows. Any other query makes it
 * something else, such as a prompt link (`promptLinks.ts`), so it stays a normal link.
 */
export function parseThreadAddress(href: string): ThreadAddress | null {
  if (!URL.canParse(href)) return null;
  const url = new URL(href);
  const web = url.protocol === "https:" || url.protocol === "http:";
  const path = web ? `${url.pathname}${url.search}` : promptLinkAppPath(href);
  if (path === null) return null;
  const inApp = new URL(path, "https://app.invalid");
  const keys = [...inApp.searchParams.keys()];
  if (keys.some((key) => key !== "message")) return null;
  const segments = inApp.pathname.split("/").slice(1);
  if (segments.at(-1) === "") segments.pop();
  if (segments.length !== 2) return null;
  const [environmentSegment, threadSegment] = segments as [string, string];
  const environmentId = decodeSegment(environmentSegment);
  const threadId = decodeSegment(threadSegment);
  if (environmentId === null || threadId === null) return null;
  const thread = Option.getOrNull(
    Option.all({
      environmentId: decodeEnvironmentId(environmentId),
      threadId: decodeThreadId(threadId),
    }),
  );
  const message = inApp.searchParams.get("message");
  if (thread === null || message === null) return thread;
  const messageId = Option.getOrNull(decodeMessageId(message));
  return messageId === null ? null : { ...thread, messageId };
}

/** Fork: the app link of a thread, the form that `parseThreadAddress` reads back. */
export function formatThreadAppLink(address: ThreadAddress): string {
  const base = `t3code://threads/${encodeURIComponent(address.environmentId)}/${encodeURIComponent(address.threadId)}`;
  return address.messageId === undefined
    ? base
    : `${base}?message=${encodeURIComponent(address.messageId)}`;
}
