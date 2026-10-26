import { EnvironmentId, ThreadId, type PreviewSessionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  browserTabContextRecord,
  matchComposerBrowserTabItems,
} from "./composerBrowserTabItems.ts";

const session = (
  tabId: string,
  navStatus: PreviewSessionSnapshot["navStatus"],
  updatedAt: string,
): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId,
  navStatus,
  canGoBack: false,
  canGoForward: false,
  updatedAt,
});

const sessions = [
  session("blank", { _tag: "Idle" }, "2026-10-21T15:03:00.000Z"),
  session(
    "stable",
    { _tag: "Success", url: "https://dashboard.usestable.com/billing", title: "Stable Dashboard" },
    "2026-10-21T15:01:00.000Z",
  ),
  session(
    "hn",
    { _tag: "Loading", url: "https://news.ycombinator.com/", title: "" },
    "2026-10-21T15:02:00.000Z",
  ),
];

describe("matchComposerBrowserTabItems", () => {
  it("lists loaded tabs newest first before a query is typed, skipping blank tabs", () => {
    expect(
      matchComposerBrowserTabItems({ sessions, query: "" }).map((item) => [
        item.tab.tabId,
        item.label,
        item.description,
      ]),
    ).toEqual([
      ["hn", "news.ycombinator.com", "news.ycombinator.com"],
      ["stable", "Stable Dashboard", "dashboard.usestable.com"],
    ]);
  });

  it("matches the query against the title or the url", () => {
    expect(
      matchComposerBrowserTabItems({ sessions, query: "dash" }).map((item) => item.tab.tabId),
    ).toEqual(["stable"]);
    expect(
      matchComposerBrowserTabItems({ sessions, query: "billing" }).map((item) => item.tab.tabId),
    ).toEqual(["stable"]);
  });
});

describe("browserTabContextRecord", () => {
  it("keeps the same tab id in two threads as two mentions", () => {
    const environmentId = EnvironmentId.make("env");
    const tab = { tabId: "tab-1", title: "Docs", url: "https://example.com/" };
    const first = browserTabContextRecord({ environmentId, threadId: ThreadId.make("a") }, tab);
    const second = browserTabContextRecord({ environmentId, threadId: ThreadId.make("b") }, tab);
    expect(first.contextId).not.toBe(second.contextId);
  });

  it("keeps thread and tab ids apart when either contains an underscore", () => {
    const environmentId = EnvironmentId.make("env");
    const record = (threadId: string, tabId: string) =>
      browserTabContextRecord(
        { environmentId, threadId: ThreadId.make(threadId) },
        { tabId, title: "Docs", url: "https://example.com/" },
      ).contextId;
    expect(record("a_b", "c")).not.toBe(record("a", "b_c"));
  });
});
