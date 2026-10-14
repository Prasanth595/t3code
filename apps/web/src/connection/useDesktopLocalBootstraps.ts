import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { readDesktopSecondaryBootstraps } from "./desktopLocal";

/**
 * Reactively track the desktop's secondary local backends (e.g. a parallel WSL
 * backend). Re-reads when the desktop reports a topology change; failed reads
 * retain the latest successful snapshot, while a successful empty read clears
 * it. Use this instead of reading the bridge ad hoc so every renderer consumer
 * reads the same topology.
 */
export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  const [bootstraps, setBootstraps] = useState<ReadonlyArray<DesktopEnvironmentBootstrap>>(
    readDesktopSecondaryBootstraps,
  );

  useEffect(() => {
    const read = () => setBootstraps(readDesktopSecondaryBootstraps());
    read();
    return window.desktopBridge?.onLocalEnvironmentBootstrapsChange?.(read);
  }, []);

  return bootstraps;
}
