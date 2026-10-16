import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { parseThreadAddress, type ThreadAddress } from "@t3tools/shared/threadAddress";
import { formatThreadLink, percentDecodedThreadLinkId } from "@t3tools/shared/threadLinks";
import { Atom } from "effect/reactivity";

import { useThreadShell } from "../../state/entities";
import { environmentSummaries } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { ThreadContextChip } from "../ThreadContextChip";
import { MarkdownThreadLink } from "./MarkdownThreadLink";

/**
 * Fork: the `threadLinkChips` server setting of the environment whose message holds the link.
 * A boolean atom, so a change to another setting does not render every link again.
 */
const threadLinkChipsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => get(serverEnvironment.settingsValueAtom(environmentId))?.threadLinkChips === true,
  ),
);

/**
 * Fork: a `t3-thread://` link in chat. With `threadLinkChips` on it is the attached-thread chip,
 * else the upstream link.
 */
export function ForkThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
}) {
  const chips = useAtomValue(threadLinkChipsAtom(props.environmentId));
  return chips ? <ThreadLinkChip {...props} /> : <MarkdownThreadLink {...props} />;
}

function ThreadLinkChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
}) {
  // Like MarkdownThreadLink: the percent-decoded id stands in when the id as written names no thread.
  const decodedId = percentDecodedThreadLinkId(props.threadId);
  const written = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const decoded = useThreadShell(
    written === null && decodedId !== null ? scopeThreadRef(props.environmentId, decodedId) : null,
  );
  const thread = written ?? decoded;
  const threadId = thread?.id ?? props.threadId;
  const title = thread?.title.trim() || props.label;
  return (
    <ThreadContextChip
      record={{ environmentId: props.environmentId, threadId, title }}
      copyMarkdown={formatThreadLink(threadId, title)}
    />
  );
}

const OFF_ATOM = Atom.make(false);
const NO_ENVIRONMENTS_ATOM = Atom.make<ReadonlyArray<EnvironmentId>>([]);

/**
 * Fork: the thread that `href` names by its web address (`parseThreadAddress`), when the message's
 * environment has `threadLinkChips` on and this client knows the thread's environment. Null for
 * every other link, which then renders as usual. Other links subscribe to nothing.
 */
export function useForkKnownThreadAddress(
  href: string | undefined,
  environmentId: EnvironmentId | null | undefined,
): ThreadAddress | null {
  const address = href && environmentId ? parseThreadAddress(href) : null;
  const chips = useAtomValue(
    address && environmentId ? threadLinkChipsAtom(environmentId) : OFF_ATOM,
  );
  const knownIds = useAtomValue(
    chips ? environmentSummaries.environmentIdsAtom : NO_ENVIRONMENTS_ATOM,
  );
  return address && knownIds.includes(address.environmentId) ? address : null;
}

/** Fork: the attached-thread chip for a thread web address that `useForkKnownThreadAddress` found. */
export function ForkThreadAddressChip(props: {
  readonly address: ThreadAddress;
  readonly href: string;
  readonly label: string;
}) {
  const shell = useThreadShell(scopeThreadRef(props.address.environmentId, props.address.threadId));
  // A bare address is its own label; the chip then needs a word, not the address.
  const label = URL.canParse(props.label) ? "Thread" : props.label;
  const title = shell?.title.trim() || label;
  return (
    <ThreadContextChip
      record={{ ...props.address, title }}
      // Copied text keeps the web address, so it still works outside T3.
      copyMarkdown={`[${title.replace(/[[\]\\\r\n]/g, " ")}](${props.href})`}
    />
  );
}
