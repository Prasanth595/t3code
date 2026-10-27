import type { SaasChatConversation } from "@t3tools/contracts/saas";
import { chatVisualsAsText } from "@t3tools/shared/htmlRender";

export interface ChatListSection {
  readonly title: string;
  readonly chats: ReadonlyArray<SaasChatConversation>;
}

const DAY_MS = 86_400_000;
const MAX_PREVIEW_LENGTH = 140;
const MONTH_FORMATTER = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const startOfDay = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();

/** Chats, newest first, under Today, Yesterday, Previous 7 days, Previous 30 days, then months. */
export function chatListSections(
  chats: ReadonlyArray<SaasChatConversation>,
  now: Date,
): ReadonlyArray<ChatListSection> {
  const today = startOfDay(now);
  const sections: Array<{ title: string; chats: Array<SaasChatConversation> }> = [];
  for (const chat of chats) {
    const at = Date.parse(chat.updatedAt);
    const title =
      at >= today
        ? "Today"
        : at >= today - DAY_MS
          ? "Yesterday"
          : at >= today - 7 * DAY_MS
            ? "Previous 7 days"
            : at >= today - 30 * DAY_MS
              ? "Previous 30 days"
              : MONTH_FORMATTER.format(at);
    const last = sections.at(-1);
    if (last?.title === title) last.chats.push(chat);
    else sections.push({ title, chats: [chat] });
  }
  return sections;
}

/** Today's chats show their time; older ones their date. */
export function chatTimeLabel(updatedAt: string, now: Date): string {
  const at = Date.parse(updatedAt);
  return at >= startOfDay(now) ? TIME_FORMATTER.format(at) : DATE_FORMATTER.format(at);
}

/** The latest message as one plain line, with markdown marks and visuals reduced to words. */
export function chatPreview(chat: SaasChatConversation): string {
  const last = chat.messages.at(-1);
  if (last === undefined) return "";
  const text = chatVisualsAsText(last.content)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#~|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (text || last.attachments?.[0]?.name || "").slice(0, MAX_PREVIEW_LENGTH);
}
