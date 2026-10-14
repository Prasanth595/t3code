/**
 * Fork: the open sidebar group tab, per device. It lives in its own localStorage key, so routes
 * that unmount the sidebar (Settings) do not reset it.
 */
import { create } from "zustand";

import { DEFAULT_SIDEBAR_GROUP_ID } from "./sidebarGroups.logic";

const STORAGE_KEY = "t3code:sidebar-group-tab:v1";

function readTabId(): string {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_GROUP_ID;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === null || stored.length === 0 ? DEFAULT_SIDEBAR_GROUP_ID : stored;
}

interface SidebarGroupTabState {
  readonly tabId: string;
  readonly setTabId: (tabId: string) => void;
}

export const useSidebarGroupTabStore = create<SidebarGroupTabState>((set) => ({
  tabId: readTabId(),
  setTabId: (tabId) => {
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, tabId);
    set({ tabId });
  },
}));
