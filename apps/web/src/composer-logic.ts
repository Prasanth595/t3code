import type { ClientSettings } from "@t3tools/contracts/settings";
import type { AssistantCitation, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  joinLeadingAssistantCitations,
  serializeAssistantCitation,
  splitLeadingAssistantCitations,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import {
  splitPromptIntoComposerSegments,
  type ComposerPromptSegment,
} from "./composer-editor-mentions";

import { resolveShortcutCommand, type ShortcutEventLike } from "./keybindings";

export type ComposerTriggerKind = "path" | "pull-request" | "slash-command" | "skill";
export type ComposerSlashCommand = "model" | "plan" | "default";
export type ComposerSubmissionIntent = "foreground" | "background" | "alternate";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

/**
 * The composer's quote cards are the leading citation block of the prompt (see
 * `splitLeadingAssistantCitations`). The text editor shows only the body below them, so its
 * cursors are shifted by the block's width: collapsed, each citation and each newline counts
 * as one; expanded, the block counts its full source.
 */
export function splitComposerQuoteCards(prompt: string) {
  const { citations, body } = splitLeadingAssistantCitations(prompt);
  return { citations, body, ...quoteCardOffsets(citations, body) };
}

/** Inverse of {@link splitComposerQuoteCards} for a new body under the same cards. */
export function joinComposerQuoteCards(sources: ReadonlyArray<string>, body: string) {
  const prompt = joinLeadingAssistantCitations(sources, body);
  return {
    prompt,
    ...quoteCardOffsets(
      sources.map((source) => ({ source })),
      body,
    ),
  };
}

function quoteCardOffsets(citations: ReadonlyArray<{ source: string }>, body: string) {
  if (citations.length === 0) return { collapsedOffset: 0, expandedOffset: 0 };
  const gap = body.length > 0 ? 2 : 0;
  return {
    collapsedOffset: 2 * citations.length - 1 + gap,
    expandedOffset:
      citations.reduce((length, { source }) => length + source.length, citations.length - 1) + gap,
  };
}

/** Adds a quote card after the existing ones, leaving the text below untouched. */
export function appendLeadingAssistantCitation(prompt: string, citation: AssistantCitation) {
  const current = splitComposerQuoteCards(prompt);
  const next = joinComposerQuoteCards(
    [...current.citations.map(({ source }) => source), serializeAssistantCitation(citation)],
    current.body,
  );
  return {
    prompt: next.prompt,
    number: current.citations.length + 1,
    /** How far a collapsed cursor in the body moves. */
    cursorShift: next.collapsedOffset - current.collapsedOffset,
  };
}

/** Cards a `#` query can reference: all of them for `#`, else those whose number starts with it. */
export function matchQuoteCardsForReference(prompt: string, query: string) {
  if (!/^\d*$/u.test(query)) return [];
  return splitLeadingAssistantCitations(prompt).citations.flatMap(({ citation }, index) =>
    String(index + 1).startsWith(query) ? [{ number: index + 1, citation }] : [],
  );
}

/** Rewrites one card's comment; spaces survive while the user is still typing. */
export function setLeadingAssistantCitationComment(
  prompt: string,
  number: number,
  comment: string,
): string {
  const { citations, body } = splitLeadingAssistantCitations(prompt);
  if (!citations[number - 1]) return prompt;
  return joinLeadingAssistantCitations(
    citations.map(({ citation, source }, index) =>
      index === number - 1
        ? serializeAssistantCitation(
            withAssistantCitationComment(citation, comment, { trim: false }),
          )
        : source,
    ),
    body,
  );
}

function composerRequiresModifier(
  sendShortcut: ClientSettings["sendShortcut"] | undefined,
  prompt: string,
) {
  return (
    sendShortcut === "mod-enter" ||
    (sendShortcut === "mod-enter-multiline" && /[\r\n]/.test(prompt))
  );
}

export function composerSubmissionIntentForKey(input: {
  event: ShortcutEventLike & { isComposing?: boolean; keyCode?: number; repeat?: boolean };
  keybindings: ResolvedKeybindingsConfig;
  platform?: string;
  isMobileViewport: boolean;
  isDraftThread: boolean;
  isRunning?: boolean;
  sendShortcut?: ClientSettings["sendShortcut"];
  prompt?: string;
}): ComposerSubmissionIntent | null {
  const { event } = input;
  if (input.isMobileViewport || event.isComposing || event.keyCode === 229 || event.repeat)
    return null;
  const command = resolveShortcutCommand(event, input.keybindings, {
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    context: {
      composerFocus: true,
      draftThreadRoute: input.isDraftThread,
      turnRunning: input.isRunning === true,
    },
  });
  if (command === "composer.sendAlternate" && input.isRunning) return "alternate";
  if (command === "composer.sendBackground" && input.isDraftThread) return "background";
  if (command === "composer.sendAndNewThread" && !input.isDraftThread) return "background";
  if (command !== null || event.key !== "Enter" || event.shiftKey || event.altKey) return null;
  if (
    composerRequiresModifier(input.sendShortcut, input.prompt ?? "") &&
    !event.metaKey &&
    !event.ctrlKey
  )
    return null;
  return "foreground";
}

const isInlineTokenSegment = (segment: ComposerPromptSegment): boolean => segment.type !== "text";

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) {
    index -= 1;
  }
  return index + 1;
}

export function expandCollapsedComposerCursor(
  text: string,
  cursorInput: number,
  literalText = false,
): number {
  if (literalText) return clampCursor(text, cursorInput);
  const collapsedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return collapsedCursor;
  }

  let remaining = collapsedCursor;
  let expandedCursor = 0;

  for (const segment of segments) {
    if (
      segment.type === "mention" ||
      segment.type === "citation" ||
      segment.type === "citation-ref" ||
      segment.type === "context-reference"
    ) {
      const expandedLength = segment.source.length;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.source.length;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return expandedCursor + remaining;
    }
    remaining -= segmentLength;
    expandedCursor += segmentLength;
  }

  return expandedCursor;
}

function collapsedSegmentLength(segment: ComposerPromptSegment): number {
  if (segment.type === "text") {
    return segment.text.length;
  }
  return 1;
}

function clampCollapsedComposerCursorForSegments(
  segments: ReadonlyArray<ComposerPromptSegment>,
  cursorInput: number,
): number {
  const collapsedLength = segments.reduce(
    (total, segment) => total + collapsedSegmentLength(segment),
    0,
  );
  if (!Number.isFinite(cursorInput)) {
    return collapsedLength;
  }
  return Math.max(0, Math.min(collapsedLength, Math.floor(cursorInput)));
}

export function clampCollapsedComposerCursor(
  text: string,
  cursorInput: number,
  literalText = false,
): number {
  if (literalText) return clampCursor(text, cursorInput);
  return clampCollapsedComposerCursorForSegments(
    splitPromptIntoComposerSegments(text),
    cursorInput,
  );
}

export function collapseExpandedComposerCursor(
  text: string,
  cursorInput: number,
  literalText = false,
): number {
  if (literalText) return clampCursor(text, cursorInput);
  const expandedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return expandedCursor;
  }

  let remaining = expandedCursor;
  let collapsedCursor = 0;

  for (const segment of segments) {
    if (
      segment.type === "mention" ||
      segment.type === "citation" ||
      segment.type === "citation-ref" ||
      segment.type === "context-reference"
    ) {
      const expandedLength = segment.source.length;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.source.length;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return collapsedCursor + remaining;
    }
    remaining -= segmentLength;
    collapsedCursor += segmentLength;
  }

  return collapsedCursor;
}

export function isCollapsedCursorAdjacentToInlineToken(
  text: string,
  cursorInput: number,
  direction: "left" | "right",
): boolean {
  const segments = splitPromptIntoComposerSegments(text);
  if (!segments.some(isInlineTokenSegment)) {
    return false;
  }

  const cursor = clampCollapsedComposerCursorForSegments(segments, cursorInput);
  let collapsedOffset = 0;

  for (const segment of segments) {
    if (isInlineTokenSegment(segment)) {
      if (direction === "left" && cursor === collapsedOffset + 1) {
        return true;
      }
      if (direction === "right" && cursor === collapsedOffset) {
        return true;
      }
    }
    collapsedOffset += collapsedSegmentLength(segment);
  }

  return false;
}

export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("/")) {
    return {
      kind: "slash-command",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  const pullRequestMatch = /^#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u.exec(token);
  if (pullRequestMatch) {
    return {
      kind: "pull-request",
      query: pullRequestMatch[1] ?? "",
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  const skillPrefix = /^\p{Sc}/u.exec(token);
  if (skillPrefix) {
    return {
      kind: "skill",
      query: token.slice(skillPrefix[0].length),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

/**
 * Length of the leading part of `pasted` that continues an `@` path query
 * typed at the end of `lineBefore`, the line's plain text up to the caret. A
 * chip must read there as one non-space character, so it never passes for a
 * typed `@path`.
 */
export function pastedPathQueryLength(
  lineBefore: string,
  pasted: string,
  pathQueryActive = true,
): number {
  if (!pathQueryActive) return 0;
  if (detectComposerTrigger(lineBefore, lineBefore.length)?.kind !== "path") return 0;
  return /^\S*/.exec(pasted)![0].length;
}

/** Caret and trigger after replacing composer text and continuing at the end. */
export function composerStateAtPromptEnd(
  text: string,
  literalText = false,
): {
  cursor: number;
  trigger: ComposerTrigger | null;
} {
  const cursor = collapseExpandedComposerCursor(text, text.length, literalText);
  return {
    cursor,
    trigger: literalText
      ? null
      : detectComposerTrigger(text, expandCollapsedComposerCursor(text, cursor)),
  };
}

export function parseStandaloneComposerSlashCommand(
  text: string,
): Exclude<ComposerSlashCommand, "model"> | null {
  const match = /^\/(plan|default)\s*$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const command = match[1]?.toLowerCase();
  if (command === "plan") return "plan";
  return "default";
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}
