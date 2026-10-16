import { create } from "zustand";

// Three 900ms pulses in index.css.
const ATTENTION_DURATION_MS = 2_700;

/**
 * `/context` points the user at a thread's Context section. The request stays
 * set while the pulse runs, so a section that mounts because the same command
 * opened the details card still scrolls itself into view.
 */
export interface ThreadContextAttention {
  readonly id: number;
  readonly threadKey: string;
  /** Pulse the section. Skipped when the request also opened the card. */
  readonly highlight: boolean;
}

let nextAttentionId = 1;
let attentionTimeout: ReturnType<typeof setTimeout> | undefined;

export const useThreadContextAttentionStore = create<{
  readonly attention: ThreadContextAttention | null;
  /** Threads whose section stays visible before any usage arrives, because `/context` asked. */
  readonly requestedThreadKeys: ReadonlySet<string>;
  readonly collapsedThreadKeys: ReadonlySet<string>;
  readonly requestAttention: (threadKey: string, options: { readonly highlight: boolean }) => void;
  readonly toggleCollapsed: (threadKey: string) => void;
}>()((set) => ({
  attention: null,
  requestedThreadKeys: new Set(),
  collapsedThreadKeys: new Set(),
  requestAttention: (threadKey, options) => {
    const id = nextAttentionId++;
    clearTimeout(attentionTimeout);
    attentionTimeout = setTimeout(
      () => set((state) => (state.attention?.id === id ? { attention: null } : state)),
      ATTENTION_DURATION_MS,
    );
    set((state) => {
      const collapsedThreadKeys = new Set(state.collapsedThreadKeys);
      collapsedThreadKeys.delete(threadKey);
      return {
        attention: { id, threadKey, highlight: options.highlight },
        requestedThreadKeys: new Set(state.requestedThreadKeys).add(threadKey),
        collapsedThreadKeys,
      };
    });
  },
  toggleCollapsed: (threadKey) =>
    set((state) => {
      const collapsedThreadKeys = new Set(state.collapsedThreadKeys);
      if (!collapsedThreadKeys.delete(threadKey)) collapsedThreadKeys.add(threadKey);
      return { collapsedThreadKeys };
    }),
}));

/** Typed in full; anything with arguments stays an ordinary prompt. */
export function isContextCommand(prompt: string): boolean {
  return prompt.trim().toLowerCase() === "/context";
}
