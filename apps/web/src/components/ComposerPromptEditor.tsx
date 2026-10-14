import { removeLeadingAssistantCitation } from "@t3tools/shared/assistantCitations";
import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import {
  collapseExpandedComposerCursor,
  expandCollapsedComposerCursor,
  joinComposerQuoteCards,
  setLeadingAssistantCitationComment,
  splitComposerQuoteCards,
} from "~/composer-logic";
import { ComposerQuoteCardTray, quoteCardKeys } from "./chat/AssistantCitationCards";
import {
  ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle as TextEditorHandle,
  type ComposerPromptEditorProps as TextEditorProps,
} from "./ComposerPromptEditorTiptap";

export interface ComposerPromptEditorHandle extends TextEditorHandle {
  /** Focuses the comment of quote card `number` (1-based), once it has rendered. */
  focusQuoteCard: (number: number) => void;
}

export interface ComposerPromptEditorProps extends Omit<TextEditorProps, "editorRef"> {
  /** Keeps quote cards out of a collapsed one-line composer. */
  quoteCardsHidden?: boolean;
  editorRef: RefObject<ComposerPromptEditorHandle | null>;
}

/**
 * The composer editor. Tiptap in both modes: the `richTextEnabled` setting
 * toggles Markdown styling, never the engine. Plain mode keeps Markdown
 * markers literal; `literalText` also preserves context-token sources as text.
 *
 * The prompt's leading citations show as quote cards above the text editor, which edits only
 * the text below them. Values and cursors cross this component in full-prompt terms, so the
 * rest of the composer never sees the split.
 */
export function ComposerPromptEditor({
  value,
  cursor,
  onChange,
  editorRef,
  quoteCardsHidden = false,
  ...rest
}: ComposerPromptEditorProps) {
  const literalText = rest.literalText ?? false;
  const split = useMemo(() => splitPrompt(value, literalText), [literalText, value]);
  // Card edits report a new prompt before it comes back as `value`; text edits in between must
  // join with the newest cards, not the rendered ones.
  const latestRef = useRef(split);
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    latestRef.current = split;
  }, [split]);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const textEditorRef = useRef<TextEditorHandle>(null);
  const [focusRequest, setFocusRequest] = useState<number | null>(null);

  const sources = () => latestRef.current.citations.map(({ source }) => source);
  const toPrompt = (snapshot: ReturnType<TextEditorHandle["readSnapshot"]>) => {
    const next = joinComposerQuoteCards(sources(), snapshot.value);
    return {
      value: next.prompt,
      cursor: snapshot.cursor + next.collapsedOffset,
      expandedCursor: snapshot.expandedCursor + next.expandedOffset,
      contextIds: snapshot.contextIds,
    };
  };
  const textSnapshot = () =>
    textEditorRef.current?.readSnapshot() ?? {
      value: latestRef.current.body,
      cursor: Math.max(0, cursor - latestRef.current.collapsedOffset),
      expandedCursor: latestRef.current.body.length,
      contextIds: [],
    };

  const onTextChange = useCallback<TextEditorProps["onChange"]>(
    (body, bodyCursor, bodyExpandedCursor, cursorAdjacentToMention, contextIds) => {
      const next = joinComposerQuoteCards(
        latestRef.current.citations.map(({ source }) => source),
        body,
      );
      onChangeRef.current(
        next.prompt,
        bodyCursor + next.collapsedOffset,
        bodyExpandedCursor + next.expandedOffset,
        cursorAdjacentToMention,
        contextIds,
      );
    },
    [],
  );

  /** Reports a prompt whose cards changed; the caret stays where it was in the text. */
  const commitCards = (edit: (prompt: string) => string) => {
    const snapshot = textSnapshot();
    const prompt = edit(toPrompt(snapshot).value);
    const next = splitPrompt(prompt, literalText);
    latestRef.current = next;
    // Removing a card also removes its `#n` references from the text.
    const bodyCursor =
      next.body === snapshot.value
        ? snapshot.cursor
        : collapseExpandedComposerCursor(next.body, next.body.length);
    onChangeRef.current(
      prompt,
      bodyCursor + next.collapsedOffset,
      expandCollapsedComposerCursor(next.body, bodyCursor) + next.expandedOffset,
      // Card edits never open a mention or command menu.
      true,
      snapshot.contextIds,
    );
  };

  const focusText = () => {
    window.requestAnimationFrame(() => textEditorRef.current?.focus());
  };

  useImperativeHandle(editorRef, () => ({
    focus: () => textEditorRef.current?.focus(),
    focusAt: (nextCursor) =>
      textEditorRef.current?.focusAt(Math.max(0, nextCursor - latestRef.current.collapsedOffset)),
    focusAtEnd: () => textEditorRef.current?.focusAtEnd(),
    readSelectionRange: () => {
      const range = textEditorRef.current?.readSelectionRange() ?? { start: 0, end: 0 };
      const offset = latestRef.current.expandedOffset;
      return { start: range.start + offset, end: range.end + offset };
    },
    readSnapshot: () => toPrompt(textSnapshot()),
    isCaretOnVisualEdge: (edge) => textEditorRef.current?.isCaretOnVisualEdge(edge) ?? true,
    focusQuoteCard: setFocusRequest,
  }));

  const cards = useMemo(() => {
    const keys = quoteCardKeys(split.citations);
    return split.citations.map(({ citation }, index) => ({ key: keys[index]!, citation }));
  }, [split]);
  const clearFocusRequest = useCallback(() => setFocusRequest(null), []);

  return (
    <>
      {quoteCardsHidden ? null : (
        <ComposerQuoteCardTray
          cards={cards}
          disabled={rest.disabled}
          focusRequest={focusRequest}
          onFocusHandled={clearFocusRequest}
          onCommentChange={(number, comment) =>
            commitCards((prompt) => setLeadingAssistantCitationComment(prompt, number, comment))
          }
          onRemove={(number, { fromKeyboard }) => {
            const trayHadFocus =
              document.activeElement?.closest("[data-composer-quote-cards]") != null;
            commitCards((prompt) => removeLeadingAssistantCitation(prompt, number));
            if (fromKeyboard && number > 1) setFocusRequest(number - 1);
            else if (trayHadFocus) focusText();
          }}
          onExitToText={focusText}
          onSend={() => rest.onCitationSubmitAndSend?.()}
        />
      )}
      <ComposerPromptEditorTiptap
        {...rest}
        value={split.body}
        cursor={Math.max(0, cursor - split.collapsedOffset)}
        onChange={onTextChange}
        {...(rest.onCitationDraftSave
          ? {
              // Runs before this component sees the new value, so the cards are still the
              // ones that sat above the replaced text.
              onCitationDraftSave: (replacedBody: string, savedBody: string) =>
                rest.onCitationDraftSave?.(
                  joinComposerQuoteCards(sources(), replacedBody).prompt,
                  joinComposerQuoteCards(sources(), savedBody).prompt,
                ),
            }
          : {})}
        editorRef={textEditorRef}
      />
    </>
  );
}

function splitPrompt(prompt: string, literalText: boolean) {
  // A literal answer is verbatim text; it has no cards.
  return literalText
    ? { citations: [], body: prompt, collapsedOffset: 0, expandedOffset: 0 }
    : splitComposerQuoteCards(prompt);
}
