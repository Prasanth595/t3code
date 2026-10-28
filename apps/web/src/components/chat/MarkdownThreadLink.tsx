import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadFamilyRead } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import {
  formatThreadLink,
  guessThreadLinkRef,
  percentDecodedThreadLinkId,
  type ThreadLink,
  unknownThreadLinkLabel,
} from "@t3tools/shared/threadLinks";

import { useThreadRefs, useThreadShell } from "../../state/entities";
import { useThreadFamilyIfMissing } from "../../state/threads";
import { UnresolvedChip } from "../contextChipParts";
import { ThreadContextChip } from "../ThreadContextChip";

/** `label` is the link's written text; an autolink has none. */
export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly link: ThreadLink;
  readonly label: string | null;
}) {
  const environmentId = props.link.environmentId ?? props.environmentId;
  const decodedId = percentDecodedThreadLinkId(props.link.threadId);
  const writtenRef = scopeThreadRef(environmentId, props.link.threadId);
  const written = useThreadShell(writtenRef);
  const writtenFamily = useThreadFamilyIfMissing(writtenRef, written === null);
  const writtenMissing =
    written === null &&
    AsyncResult.isSuccess(writtenFamily) &&
    !writtenFamily.waiting &&
    !writtenFamily.value.threads.some((thread) => thread.id === props.link.threadId);
  const decodedRef =
    writtenMissing && decodedId !== null ? scopeThreadRef(environmentId, decodedId) : null;
  const decoded = useThreadShell(decodedRef);
  const decodedFamily = useThreadFamilyIfMissing(
    decodedRef,
    decodedRef !== null && decoded === null,
  );
  const decodedMissing =
    decodedId === null ||
    (decoded === null &&
      AsyncResult.isSuccess(decodedFamily) &&
      !decodedFamily.waiting &&
      !decodedFamily.value.threads.some((thread) => thread.id === decodedId));
  const local = written ?? decoded;
  const lookupFailed =
    threadFamilyRead(writtenFamily) === "failed" || threadFamilyRead(decodedFamily) === "failed";
  const guess =
    local === null &&
    (lookupFailed || (writtenMissing && decodedMissing)) &&
    props.link.environmentId === null;
  const refs = useThreadRefs(guess);
  const remote = useThreadShell(
    guess
      ? guessThreadLinkRef(
          props.link,
          refs.filter((ref) => ref.environmentId !== environmentId),
        )
      : null,
  );
  const thread = local ?? remote;
  if (thread === null) {
    const unknown = unknownThreadLinkLabel(props.link, props.environmentId);
    return <UnresolvedChip label={props.label ?? unknown} tooltip={unknown} />;
  }
  const ref = { environmentId: thread.environmentId, threadId: thread.id };
  const title = thread.title.trim() || props.label || "Untitled thread";
  return (
    <ThreadContextChip record={{ ...ref, title }} copyMarkdown={formatThreadLink(ref, title)} />
  );
}
