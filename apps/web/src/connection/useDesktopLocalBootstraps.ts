import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { readDesktopSecondaryBootstraps } from "./desktopLocal";

// Only for desktop shells that predate the bootstraps change event.
const LEGACY_BRIDGE_POLL_MS = 2_000;

/**
 * Reactively track the desktop's secondary local backends (e.g. a parallel WSL
 * backend). Re-reads when the desktop reports a topology change, or on an
 * interval for older shells without the event; failed reads retain the latest
 * successful snapshot, while a successful empty read clears it. Use this
 * instead of reading the bridge ad hoc so every renderer consumer reads the
 * same topology.
 */
export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  const [bootstraps, setBootstraps] = useState<ReadonlyArray<DesktopEnvironmentBootstrap>>(
    readDesktopSecondaryBootstraps,
  );

  useEffect(() => {
    const read = () => setBootstraps(readDesktopSecondaryBootstraps());
    read();
    const subscribe = window.desktopBridge?.onLocalEnvironmentBootstrapsChange;
    if (subscribe) return subscribe(read);
    const interval = setInterval(read, LEGACY_BRIDGE_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  return bootstraps;
}
