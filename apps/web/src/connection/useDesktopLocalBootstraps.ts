import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { readDesktopSecondaryBootstraps } from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = 2_000;
const DESKTOP_LOCAL_BOOTSTRAP_HIDDEN_POLL_MS = 10_000;

/**
 * Reactively track the desktop's secondary local backends (e.g. a parallel WSL
 * backend). The bridge exposes no change event, so we re-read on an interval;
 * failed reads retain the latest successful snapshot, while a successful empty
 * read clears it. Use this instead of polling the bridge ad hoc so every
 * renderer consumer reads the same topology.
 *
 * While the tab is hidden the topology can wait: the interval backs off to a
 * slow heartbeat that does no reads and no commits, and returning to the tab
 * re-reads immediately.
 */
export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  const [bootstraps, setBootstraps] = useState<ReadonlyArray<DesktopEnvironmentBootstrap>>(
    readDesktopSecondaryBootstraps,
  );

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const showing = () => document.visibilityState === "visible";
    const schedule = () => {
      clearTimeout(timer);
      if (disposed) return;
      timer = setTimeout(
        tick,
        showing() ? DESKTOP_LOCAL_BOOTSTRAP_POLL_MS : DESKTOP_LOCAL_BOOTSTRAP_HIDDEN_POLL_MS,
      );
    };
    const tick = () => {
      if (disposed) return;
      if (showing()) {
        setBootstraps(readDesktopSecondaryBootstraps());
      }
      schedule();
    };
    const onReturn = () => {
      if (disposed || !showing()) return;
      setBootstraps(readDesktopSecondaryBootstraps());
      schedule();
    };
    setBootstraps(readDesktopSecondaryBootstraps());
    schedule();
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, []);

  return bootstraps;
}
