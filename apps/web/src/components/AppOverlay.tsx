import { RotateCwIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { create } from "zustand";

import { Button } from "./ui/button";

interface AppOverlayStore {
  /** The page the overlay holds. It stays loaded while the overlay is hidden. */
  readonly url: string | null;
  readonly title: string;
  readonly open: boolean;
  /** Changes when the page must load again. */
  readonly loadId: number;
  /** Shows `url`, or hides the overlay when it already shows `url`. */
  readonly toggle: (url: string, title: string) => void;
  /** Shows `url` and loads it again, for a page whose server just started. */
  readonly showFresh: (url: string, title: string) => void;
  readonly reload: () => void;
  readonly hide: () => void;
}

export const useAppOverlayStore = create<AppOverlayStore>()((set, get) => ({
  url: null,
  title: "",
  open: false,
  loadId: 0,
  toggle: (url, title) => {
    const current = get();
    if (current.open && current.url === url) {
      set({ open: false });
      return;
    }
    set({ url, title, open: true });
  },
  showFresh: (url, title) =>
    set((current) => ({ url, title, open: true, loadId: current.loadId + 1 })),
  reload: () => set((current) => ({ loadId: current.loadId + 1 })),
  hide: () => set({ open: false }),
}));

/**
 * Fork: a large panel over the whole app for an action's web page (`previewOverlay`). It opens
 * and closes without animation, and the page stays loaded while it is hidden, so it reopens at
 * once with its state. Click outside, press Escape outside the page, run the action again, or
 * let the page post `{ type: "t3:close-overlay" }` to close it.
 */
export function AppOverlay() {
  const { url, title, open, loadId, reload, hide } = useAppOverlayStore();
  const frameRef = useRef<HTMLIFrameElement>(null);

  // The page may ask to close, for example after the user picked something in it. Only the
  // overlay's own page counts, and only this one message: `{ type: "t3:close-overlay" }`.
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source === null || event.source !== frameRef.current?.contentWindow) return;
      const data = event.data;
      if (
        typeof data === "object" &&
        data !== null &&
        "type" in data &&
        data.type === "t3:close-overlay"
      ) {
        hide();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [hide]);

  useEffect(() => {
    if (!open) return;
    // The page takes the keyboard at once, as a native panel would.
    frameRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, hide]);

  if (url === null) return null;
  return (
    <div
      hidden={!open}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 [-webkit-app-region:no-drag]"
      data-app-overlay
    >
      <div aria-hidden className="absolute inset-0 bg-black/40" onClick={hide} />
      <div className="absolute inset-x-[3vw] top-[4vh] bottom-[4vh] flex flex-col overflow-hidden rounded-xl border bg-background shadow-2xl">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b pr-1.5 pl-3">
          <span className="min-w-0 flex-1 truncate font-medium text-sm">{title}</span>
          <Button size="icon-xs" variant="ghost" aria-label={`Reload ${title}`} onClick={reload}>
            <RotateCwIcon className="size-3.5" />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label={`Close ${title}`} onClick={hide}>
            <XIcon className="size-4" />
          </Button>
        </div>
        {/* oxlint-disable-next-line react/iframe-missing-sandbox -- The page is the user's own local tool and must call its own server: an opaque sandbox origin gets refused there, and with allow-same-origin a sandbox restricts nothing. */}
        <iframe
          key={`${url}#${loadId}`}
          ref={frameRef}
          src={url}
          title={title}
          allow="clipboard-read; clipboard-write"
          className="min-h-0 flex-1 border-0 bg-background"
        />
      </div>
    </div>
  );
}

/** True when something serves `url`. An opaque answer counts: only a network failure does not. */
export async function pageAnswers(url: string): Promise<boolean> {
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

/** Waits for a page that a command just started, for at most `timeoutMs`. */
export async function waitForPage(url: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pageAnswers(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
