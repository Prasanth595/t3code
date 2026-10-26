import type {
  BrowserTabContextRecord,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";

const COMPOSER_BROWSER_TAB_RESULT_LIMIT = 5;

export interface ComposerBrowserTab {
  readonly tabId: string;
  readonly title: string;
  readonly url: string;
}

export interface ComposerBrowserTabItem {
  readonly id: string;
  readonly type: "browser-tab";
  readonly tab: ComposerBrowserTab;
  readonly label: string;
  readonly description: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * Agents can only drive the tabs of the thread they run in, so candidates are that thread's
 * sessions. A blank tab has nothing to work on yet.
 */
export function matchComposerBrowserTabItems(input: {
  sessions: ReadonlyArray<PreviewSessionSnapshot>;
  query: string;
}): ComposerBrowserTabItem[] {
  const query = input.query.trim().toLowerCase();
  return input.sessions
    .flatMap((session) => {
      if (session.navStatus._tag === "Idle") return [];
      const { url } = session.navStatus;
      const title = session.navStatus.title.trim() || hostOf(url);
      return [{ session, tab: { tabId: session.tabId, title, url } }];
    })
    .filter(
      ({ tab }) =>
        query.length === 0 ||
        tab.title.toLowerCase().includes(query) ||
        tab.url.toLowerCase().includes(query),
    )
    .sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt))
    .slice(0, COMPOSER_BROWSER_TAB_RESULT_LIMIT)
    .map(({ tab }) => ({
      id: `browser-tab:${tab.tabId}`,
      type: "browser-tab",
      tab,
      label: tab.title,
      description: hostOf(tab.url),
    }));
}

/** One record per tab, so mentioning the same tab again reuses its chip. */
export function browserTabContextRecord(
  threadRef: ScopedThreadRef,
  tab: ComposerBrowserTab,
): BrowserTabContextRecord {
  const label = sanitizeComposerContextLabel(tab.title, "browser-tab");
  return {
    version: 1,
    kind: "browser-tab",
    // Tab ids are per-process sequence numbers, so two threads can share one. Both ids may
    // contain any separator, so encode the pair unambiguously.
    contextId: toKindScopedComposerContextId(
      "browser-tab",
      JSON.stringify([threadRef.threadId, tab.tabId]),
    ),
    label,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    tabId: tab.tabId,
    title: label,
    url: tab.url,
  };
}
