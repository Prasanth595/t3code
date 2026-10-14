import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { APP_BASE_NAME } from "../../branding";
import { requestConfirmDialog } from "../../confirmDialog";
import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadShells } from "../../state/threads";
import {
  formatQuitConfirmation,
  isBusyThreadShell,
  isDesktopOwnedTarget,
} from "./DesktopCloseGuard.logic";

const busyThreadTitlesAtom = Atom.make((get) => {
  const titles: string[] = [];
  for (const [environmentId, entry] of get(environmentCatalog.catalogValueAtom).entries) {
    if (!entry.enabled || !isDesktopOwnedTarget(entry.target)) continue;
    for (const thread of get(environmentThreadShells.environmentThreadsAtom(environmentId))) {
      if (isBusyThreadShell(thread)) titles.push(thread.title);
    }
  }
  return titles;
}).pipe(Atom.withLabel("web-desktop-busy-thread-titles"));

// A number, so shell updates that leave the count alone do not re-render.
const busyThreadCountAtom = Atom.map(busyThreadTitlesAtom, (titles) => titles.length).pipe(
  Atom.withLabel("web-desktop-busy-thread-count"),
);

async function confirmQuit(): Promise<boolean> {
  const [first, ...rest] = appAtomRegistry.get(busyThreadTitlesAtom);
  if (first === undefined) return true;
  // Without a mounted dialog host nothing can answer, so let the quit proceed.
  return (
    (await requestConfirmDialog(formatQuitConfirmation(APP_BASE_NAME, [first, ...rest]), {
      variant: "destructive",
    })) ?? true
  );
}

/**
 * Desktop only. Reports how many desktop-owned threads are busy, and answers
 * the desktop's request to confirm closing the window or quitting while any
 * are.
 */
export function DesktopCloseGuard() {
  const busyThreadCount = useAtomValue(busyThreadCountAtom);
  const closeGuard = window.desktopBridge?.closeGuard;

  useEffect(() => {
    closeGuard?.setBusyThreadCount(busyThreadCount);
  }, [closeGuard, busyThreadCount]);

  useEffect(() => {
    if (!closeGuard) return;
    const unsubscribe = closeGuard.onConfirmRequest(confirmQuit);
    return () => {
      unsubscribe();
      closeGuard.setBusyThreadCount(0);
    };
  }, [closeGuard]);

  return null;
}
