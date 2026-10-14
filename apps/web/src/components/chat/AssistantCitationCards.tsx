import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { Link, useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import {
  assistantCitationHash,
  assistantCitationNavigation,
} from "../../lib/assistantCitationNavigation";
import { findAssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { observePendingAssistantCitationSource } from "./AssistantCitationSource";

/**
 * The number that ties a quote card to `#n` references. Sized in em so it sits in running text
 * (composer, Markdown) as well as on cards.
 */
export function AssistantCitationNumber({
  number,
  className,
  render,
  ...props
}: useRender.ComponentProps<"span"> & { number: number }) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(
          "inline-flex h-[1.41em] min-w-[1.41em] shrink-0 items-center justify-center rounded-full bg-primary px-1 align-middle font-semibold text-[0.86em] text-primary-foreground tabular-nums leading-none [button&,a&]:cursor-pointer",
          className,
        ),
        children: number,
      },
      props,
    ),
    render,
  });
}

/** Plain clicks reveal the passage in place; modified clicks keep the link's native behaviour. */
function useSourceLinkProps(citation: AssistantCitation) {
  const navigate = useNavigate();
  return {
    to: "/$environmentId/$threadId" as const,
    params: { environmentId: citation.environmentId, threadId: citation.threadId },
    hash: assistantCitationHash(citation),
    resetScroll: false,
    onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      void navigate(assistantCitationNavigation(citation));
    },
  };
}

/**
 * Marks the quoted passage while the pointer is over its card. Costs nothing until hovered, and
 * nothing when the passage is not mounted (another thread, or scrolled out of the virtual list).
 */
function useSourceHoverHighlight(citation: AssistantCitation) {
  const disposeRef = useRef<(() => void) | null>(null);
  const clear = () => {
    disposeRef.current?.();
    disposeRef.current = null;
  };
  useEffect(() => () => disposeRef.current?.(), []);
  return {
    onPointerEnter: () => {
      clear();
      const anchor = findAssistantCitationSourceAnchor(document, citation);
      if (!anchor) return;
      disposeRef.current = observePendingAssistantCitationSource({
        anchor,
        citation,
        onUnavailable: () => {
          disposeRef.current = null;
        },
      });
    },
    onPointerLeave: clear,
  };
}

/**
 * Keys that survive comment edits and renumbering: the quoted passage, plus an occurrence count
 * for a passage quoted twice.
 */
export function quoteCardKeys(citations: ReadonlyArray<{ citation: AssistantCitation }>) {
  const seen = new Map<string, number>();
  return citations.map(({ citation }) => {
    const passage = [
      citation.environmentId,
      citation.threadId,
      citation.messageId,
      citation.start,
      citation.end,
    ].join("\u0000");
    const occurrence = seen.get(passage) ?? 0;
    seen.set(passage, occurrence + 1);
    return `${passage}\u0000${occurrence}`;
  });
}

export interface ComposerQuoteCard {
  /** Stable while the card exists, across comment edits and renumbering. */
  key: string;
  citation: AssistantCitation;
}

/**
 * Quotes waiting above the composer text. Each card shows its quote and an inline comment field.
 * `focusRequest` names a card to focus once it renders (a fresh citation lands before the prompt
 * update does).
 */
export function ComposerQuoteCardTray({
  cards,
  disabled,
  focusRequest,
  onFocusHandled,
  onCommentChange,
  onRemove,
  onExitToText,
  onSend,
}: {
  cards: ReadonlyArray<ComposerQuoteCard>;
  disabled: boolean;
  focusRequest: number | null;
  onFocusHandled: () => void;
  onCommentChange: (number: number, comment: string) => void;
  onRemove: (number: number, options: { fromKeyboard: boolean }) => void;
  onExitToText: () => void;
  onSend: () => void;
}) {
  const trayRef = useRef<HTMLDivElement>(null);
  // Every render: the requested card may only now have mounted.
  useLayoutEffect(() => {
    if (focusRequest === null) return;
    const input =
      trayRef.current?.querySelectorAll<HTMLTextAreaElement>("textarea")[focusRequest - 1];
    if (!input) return;
    onFocusHandled();
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    input.closest("[data-quote-card]")?.scrollIntoView({ block: "nearest" });
  });

  if (cards.length === 0) return null;
  return (
    <div
      ref={trayRef}
      role="list"
      aria-label="Quoted replies"
      // About three cards tall; more scroll here instead of pushing the conversation away.
      className="mb-2 flex max-h-56 flex-col gap-1.5 overflow-y-auto overscroll-contain"
      data-composer-quote-cards="true"
    >
      {cards.map((card, index) => (
        <ComposerQuoteCardItem
          key={card.key}
          citation={card.citation}
          number={index + 1}
          disabled={disabled}
          onCommentChange={onCommentChange}
          onRemove={onRemove}
          onExitToText={onExitToText}
          onSend={onSend}
        />
      ))}
    </div>
  );
}

function ComposerQuoteCardItem({
  citation,
  number,
  disabled,
  onCommentChange,
  onRemove,
  onExitToText,
  onSend,
}: {
  citation: AssistantCitation;
  number: number;
  disabled: boolean;
  onCommentChange: (number: number, comment: string) => void;
  onRemove: (number: number, options: { fromKeyboard: boolean }) => void;
  onExitToText: () => void;
  onSend: () => void;
}) {
  const sourceLink = useSourceLinkProps(citation);
  const hover = useSourceHoverHighlight(citation);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) onSend();
      else onExitToText();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onExitToText();
      return;
    }
    if (event.key === "Backspace" && event.currentTarget.value.length === 0) {
      event.preventDefault();
      onRemove(number, { fromKeyboard: true });
    }
  };
  return (
    <div
      role="listitem"
      aria-label={`Quote ${number}`}
      data-quote-card="true"
      className="group/card grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 rounded-xl border border-border bg-background/60 py-1.5 ps-2 pe-1 hover:border-primary/40 focus-within:border-primary/50"
      {...hover}
    >
      <AssistantCitationNumber
        number={number}
        className="mt-0.5 text-xs"
        aria-label={`Show quote ${number} in the conversation`}
        render={<Link {...sourceLink} />}
      />
      <div className="min-w-0">
        <Link
          {...sourceLink}
          data-markdown-copy={serializeAssistantCitation(citation)}
          className="line-clamp-2 border-primary/60 border-s-2 ps-2 text-muted-foreground text-sm whitespace-pre-wrap wrap-break-word no-underline hover:text-foreground"
          aria-label={`Quote ${number}: ${citation.text.trim()}. Show it in the conversation.`}
        >
          {citation.text.trim()}
        </Link>
        <textarea
          aria-label={`Comment on quote ${number}`}
          aria-description="Enter returns to the message, Command or Control+Enter sends, Backspace in an empty comment removes the quote."
          placeholder="Add a comment (optional)"
          rows={1}
          maxLength={ASSISTANT_CITATION_MAX_COMMENT_LENGTH}
          disabled={disabled}
          className="mt-1 field-sizing-content block max-h-30 min-h-5 w-full resize-none bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground sm:text-sm"
          value={citation.comment ?? ""}
          onChange={(event) => onCommentChange(number, event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <Button
        variant="ghost-muted"
        size="icon-xs"
        aria-label={`Remove quote ${number}`}
        disabled={disabled}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => onRemove(number, { fromKeyboard: false })}
      >
        <XIcon />
      </Button>
    </div>
  );
}

/**
 * Read-only quote cards above a sent message's text. Each one reveals its passage again. Only
 * comments take part in thread find; quotes belong to the reply they came from.
 */
export function SentQuoteCards({
  citations,
}: {
  citations: ReadonlyArray<{ citation: AssistantCitation; source: string }>;
}) {
  if (citations.length === 0) return null;
  const keys = quoteCardKeys(citations);
  return (
    <div className="mb-2 flex flex-col gap-1.5" data-thread-find-text="true">
      {citations.map(({ citation, source }, index) => (
        <SentQuoteCard key={keys[index]} citation={citation} number={index + 1} source={source} />
      ))}
    </div>
  );
}

function SentQuoteCard({
  citation,
  number,
  source,
}: {
  citation: AssistantCitation;
  number: number;
  source: string;
}) {
  const sourceLink = useSourceLinkProps(citation);
  const hover = useSourceHoverHighlight(citation);
  const comment = citation.comment?.trim();
  return (
    <Link
      {...sourceLink}
      {...hover}
      data-markdown-copy={source}
      aria-label={`Quote ${number}: ${citation.text.trim()}. Show it in the conversation.`}
      className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 rounded-xl border border-border bg-background/50 px-2 py-1.5 text-start text-message-foreground no-underline hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-foreground"
    >
      <span data-thread-find-ignore className="contents">
        <AssistantCitationNumber number={number} className="mt-0.5 text-xs" />
        <span className="line-clamp-2 border-primary/60 border-s-2 ps-2 text-muted-foreground text-sm whitespace-pre-wrap wrap-break-word">
          {citation.text.trim()}
        </span>
      </span>
      {comment ? (
        <p className="col-start-2 text-sm whitespace-pre-wrap wrap-break-word">{comment}</p>
      ) : null}
    </Link>
  );
}
