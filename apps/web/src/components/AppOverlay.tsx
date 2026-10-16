import type { EnvironmentId, ProjectScript } from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import { RotateCwIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { create } from "zustand";

import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { readPreparedConnection } from "~/state/session";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";

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

const useAppOverlayStore = create<AppOverlayStore>()((set, get) => ({
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

/** True when the environment runs on the machine that draws this client. */
function environmentIsThisMachine(environmentId: EnvironmentId): boolean {
  const connection = readPreparedConnection(environmentId);
  if (!connection) return false;
  if (
    isElectron &&
    (connection.target._tag === "PrimaryConnectionTarget" ||
      isDesktopLocalConnectionTarget(connection.target))
  ) {
    return true;
  }
  return isLocalLoopbackHost(new URL(connection.httpBaseUrl).hostname);
}

/**
 * The page that the overlay shows for an action, or null when the action uses the preview path.
 * A remote client cannot frame the page: an HTTPS page blocks an `http:` frame as mixed content,
 * and another machine's loopback page is not reachable from here.
 */
function appOverlayUrl(environmentId: EnvironmentId, script: ProjectScript): string | null {
  if (!script.previewOverlay || !script.previewUrl) return null;
  if (!environmentIsThisMachine(environmentId)) return null;
  const url = resolveDiscoveredServerUrl(environmentId, script.previewUrl);
  if (window.location.protocol === "https:" && url.startsWith("http:")) return null;
  return url;
}

/** The overlay pages whose check or command runs now. */
const startingOverlayUrls = new Set<string>();

/**
 * An overlay action shows its page in the app overlay and runs its command, in a background
 * terminal, only when the page is down. Null when `script` is no overlay action here, so the
 * caller runs it as usual without waiting. `runInTerminal` is undefined for a client that cannot
 * run commands.
 */
export function runAppOverlayScript(
  environmentId: EnvironmentId,
  script: ProjectScript,
  runInTerminal: ((script: ProjectScript) => Promise<void>) | undefined,
): Promise<void> | null {
  const overlayUrl = appOverlayUrl(environmentId, script);
  if (overlayUrl === null) return null;
  return runAppOverlayAction(
    overlayUrl,
    script.name,
    runInTerminal
      ? () => runInTerminal({ ...script, previewOverlay: false, runInBackground: true })
      : undefined,
  );
}

/**
 * Shows the overlay page, or runs `start` first when nothing answers there. `start` is undefined
 * for a client that cannot run commands. A click while the page's check or command runs does
 * nothing, so a double click does not start two servers.
 */
async function runAppOverlayAction(
  url: string,
  title: string,
  start: (() => Promise<void>) | undefined,
): Promise<void> {
  if (startingOverlayUrls.has(url)) return;
  startingOverlayUrls.add(url);
  try {
    if (await pageAnswers(url)) {
      useAppOverlayStore.getState().toggle(url, title);
      return;
    }
    if (start === undefined) return;
    await start();
    // A hidden overlay can still hold the page of a server that stopped, for example after an
    // upgrade. Load it again so the page matches the server that just started.
    if (await waitForPage(url)) {
      useAppOverlayStore.getState().showFresh(url, title);
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `${title} did not start`,
        description: `Nothing answered at ${url}. Its command runs in a background terminal.`,
      }),
    );
  } finally {
    startingOverlayUrls.delete(url);
  }
}

/** True when something serves `url`. An opaque answer counts: only a network failure does not. */
async function pageAnswers(url: string): Promise<boolean> {
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

/** Waits for a page that a command just started, for at most `timeoutMs`. */
async function waitForPage(url: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pageAnswers(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
