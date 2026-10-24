import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { createNavigationHistoryStore } from "./navigationHistory";

describe("navigation history controls", () => {
  it("picks up navigation before the controls subscribe", () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const store = createNavigationHistoryStore(history);

    history.push("/threads/one");
    expect(store.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });
    history.push("/settings");
    const unsubscribe = store.subscribe(() => {});
    try {
      history.back();
      expect(store.getSnapshot()).toEqual({ canGoBack: true, canGoForward: true });
    } finally {
      unsubscribe();
    }
  });

  it("restores forward availability when mounting inside existing history", () => {
    const history = createMemoryHistory({
      initialEntries: ["/", "/threads/one", "/settings"],
      initialIndex: 1,
    });
    const store = createNavigationHistoryStore(history, 1);
    expect(store.getSnapshot()).toEqual({ canGoBack: true, canGoForward: true });
  });

  it("keeps Forward across a replace and clears it on a new push", () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const store = createNavigationHistoryStore(history);
    const unsubscribe = store.subscribe(() => {});
    try {
      expect(store.getSnapshot()).toEqual({ canGoBack: false, canGoForward: false });
      history.push("/threads/one");
      history.push("/settings");
      expect(store.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });
      history.back();
      expect(store.getSnapshot()).toEqual({ canGoBack: true, canGoForward: true });
      history.replace("/threads/two");
      expect(store.getSnapshot().canGoForward).toBe(true);
      history.forward();
      expect(store.getSnapshot().canGoForward).toBe(false);
      history.go(-2);
      expect(store.getSnapshot()).toEqual({ canGoBack: false, canGoForward: true });
      history.push("/usage");
      expect(store.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });
    } finally {
      unsubscribe();
    }
  });
});
