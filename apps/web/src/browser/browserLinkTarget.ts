import type { BrowserLinkTarget, ScopedThreadRef } from "@t3tools/contracts";

import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { isPreviewAvailableFor } from "./previewRuntime";

export interface ResolveLinkTargetInput {
  readonly url: string;
  /** Cmd/Ctrl-click and middle-click always go to the system browser, whatever the default. */
  readonly event: {
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly button?: number | undefined;
  };
  readonly preference: BrowserLinkTarget;
  readonly canOpenInApp: boolean;
}

export function resolveLinkTarget(input: ResolveLinkTargetInput): BrowserLinkTarget {
  if (input.event.metaKey || input.event.ctrlKey || input.event.button === 1) return "system";
  if (input.preference !== "app") return "system";
  if (!input.canOpenInApp) return "system";
  if (!isWebUrl(input.url)) return "system";
  return "app";
}

export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Before hydration the snapshot is the schema default ("system"), so a link clicked in the
 * first moments after launch would ignore a persisted "app" — opening is asynchronous anyway,
 * so waiting costs nothing the user can see. Read failures reject rather than choosing a
 * browser without the saved preference.
 */
export async function resolveBrowserLinkTargetPreference(): Promise<BrowserLinkTarget> {
  await ensureClientSettingsHydrated();
  return getClientSettings().browserLinkTarget;
}

export function canOpenLinksInApp(threadRef: ScopedThreadRef | null | undefined): boolean {
  return threadRef != null && isPreviewAvailableFor(threadRef.environmentId);
}
