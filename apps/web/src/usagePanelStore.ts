import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import type { ThreadPanelPresentation } from "./rightPanelLayout";

export const USAGE_PANEL_WINDOW_DAYS = [1, 7, 30] as const;
export type UsagePanelWindowDays = (typeof USAGE_PANEL_WINDOW_DAYS)[number];

interface UsagePanelState {
  inlineOpen: boolean;
  popoverOpen: boolean;
  windowDays: UsagePanelWindowDays;
  setOpen: (presentation: ThreadPanelPresentation, open: boolean) => void;
  toggle: (presentation: ThreadPanelPresentation) => void;
  setWindowDays: (days: UsagePanelWindowDays) => void;
}

const isWindowDays = (value: unknown): value is UsagePanelWindowDays =>
  USAGE_PANEL_WINDOW_DAYS.some((days) => days === value);

/** Open state and window are per client, not per thread: usage belongs to the account. */
export const useUsagePanelStore = create<UsagePanelState>()(
  persist(
    (set) => ({
      inlineOpen: true,
      popoverOpen: false,
      windowDays: 1,
      setOpen: (presentation, open) =>
        set(presentation === "inline" ? { inlineOpen: open } : { popoverOpen: open }),
      toggle: (presentation) =>
        set((state) =>
          presentation === "inline"
            ? { inlineOpen: !state.inlineOpen }
            : { popoverOpen: !state.popoverOpen },
        ),
      setWindowDays: (windowDays) => set({ windowDays }),
    }),
    {
      name: "t3code:usage-panel:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ inlineOpen: state.inlineOpen, windowDays: state.windowDays }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<
          Pick<UsagePanelState, "inlineOpen" | "windowDays">
        > | null;
        return {
          ...current,
          inlineOpen: saved?.inlineOpen === false ? false : current.inlineOpen,
          windowDays: isWindowDays(saved?.windowDays) ? saved.windowDays : current.windowDays,
        };
      },
    },
  ),
);

export function selectUsagePanelOpen(
  state: Pick<UsagePanelState, "inlineOpen" | "popoverOpen">,
  presentation: ThreadPanelPresentation,
): boolean {
  return presentation === "inline" ? state.inlineOpen : state.popoverOpen;
}
