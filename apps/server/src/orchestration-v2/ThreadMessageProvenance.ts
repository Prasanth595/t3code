import type { OrchestrationV2ConversationMessage, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const MAX_TITLE_LENGTH = 120;

type MessageProvenanceFields = Pick<
  OrchestrationV2ConversationMessage,
  "createdBy" | "senderThreadId"
>;

export interface ThreadMessageSender {
  readonly senderTitle?: string;
  readonly isDelegatedTaskChild?: boolean;
}

/** Collapse whitespace and strip header metacharacters so a title stays on one line. */
export function sanitizeThreadTitle(title: string | undefined | null): string | undefined {
  if (title === undefined || title === null) return undefined;
  const cleaned = title
    .replaceAll(/\s+/g, " ")
    .replaceAll('"', "'")
    .replaceAll("[", "(")
    .replaceAll("]", ")")
    .trim();
  if (cleaned === "") return undefined;
  return cleaned.length > MAX_TITLE_LENGTH ? `${cleaned.slice(0, MAX_TITLE_LENGTH - 1)}…` : cleaned;
}

/**
 * One-line provenance prefix for a message one thread's agent sent into another.
 * The stored timeline item is untouched; this only shapes provider-bound text.
 */
export function threadMessageProvenanceHeader(input: {
  readonly senderThreadId: ThreadId;
  readonly senderTitle?: string;
  readonly isDelegatedTaskChild?: boolean;
}): string {
  const title = sanitizeThreadTitle(input.senderTitle);
  const named =
    title === undefined ? `${input.senderThreadId}` : `"${title}" (${input.senderThreadId})`;
  return input.isDelegatedTaskChild === true
    ? `[T3 message from your delegated task ${named}, sent by an agent, not the user]`
    : `[T3 message from thread ${named}, sent by an agent, not the user]`;
}

/**
 * Prefix provider-bound text with its provenance header. Only agent-authored
 * messages carrying a sender thread are prefixed; the original text is never altered.
 */
export function withThreadMessageProvenance(
  text: string,
  message: MessageProvenanceFields & ThreadMessageSender,
): string {
  if (message.createdBy !== "agent" || message.senderThreadId === undefined) return text;
  const header = threadMessageProvenanceHeader({
    senderThreadId: message.senderThreadId,
    ...(message.senderTitle === undefined ? {} : { senderTitle: message.senderTitle }),
    ...(message.isDelegatedTaskChild === undefined
      ? {}
      : { isDelegatedTaskChild: message.isDelegatedTaskChild }),
  });
  return `${header}\n${text}`;
}

/**
 * Resolve the sender title and whether the sender is a delegated-task child of
 * the receiving thread. Any lookup failure degrades to the id-only header.
 */
export const resolveThreadMessageSender = (input: {
  readonly loadThread: (threadId: ThreadId) => Effect.Effect<
    | {
        readonly thread: {
          readonly title: string;
          readonly lineage: { readonly parentThreadId: ThreadId | null };
        };
      }
    | undefined,
    never
  >;
  readonly receiverThreadId: ThreadId;
  readonly receiverChildThreadIds: ReadonlyArray<ThreadId>;
  readonly message: MessageProvenanceFields;
}): Effect.Effect<ThreadMessageSender> =>
  input.message.senderThreadId === undefined
    ? Effect.succeed({})
    : input.loadThread(input.message.senderThreadId).pipe(
        Effect.map((loaded) => {
          const senderThreadId = input.message.senderThreadId;
          if (senderThreadId === undefined) return {};
          const isDelegatedTaskChild =
            loaded?.thread.lineage.parentThreadId === input.receiverThreadId ||
            input.receiverChildThreadIds.includes(senderThreadId);
          return {
            ...(loaded === undefined ? {} : { senderTitle: loaded.thread.title }),
            isDelegatedTaskChild,
          } satisfies ThreadMessageSender;
        }),
      );
