import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface ThreadAddress {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Fork: the thread that a web address of a T3 server names, `https://<host>/<environmentId>/<threadId>`.
 * The host does not matter: the environment id is the identity, so a client checks it against the
 * environments it knows. A query makes it something else, such as a prompt link (`promptLinks.ts`),
 * so it stays a normal link.
 */
export function parseThreadAddress(href: string): ThreadAddress | null {
  if (!URL.canParse(href)) return null;
  const url = new URL(href);
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.search !== "") return null;
  const segments = url.pathname.split("/").slice(1);
  if (segments.at(-1) === "") segments.pop();
  if (segments.length !== 2) return null;
  const [environmentSegment, threadSegment] = segments as [string, string];
  const environmentId = decodeSegment(environmentSegment);
  const threadId = decodeSegment(threadSegment);
  if (environmentId === null || threadId === null) return null;
  return Option.getOrNull(
    Option.all({
      environmentId: decodeEnvironmentId(environmentId),
      threadId: decodeThreadId(threadId),
    }),
  );
}
