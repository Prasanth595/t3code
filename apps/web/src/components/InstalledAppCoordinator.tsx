import { useEffect } from "react";

import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import {
  listenForInstalledAppNotificationClicks,
  syncInstalledAppServiceWorker,
} from "../installedApp";

/** Fork: keeps the service worker of the installed web app in step with `installedAppEnabled`. */
export function InstalledAppCoordinator() {
  const hydrated = useClientSettingsHydrated();
  const enabled = useClientSettings((settings) => settings.installedAppEnabled);

  useEffect(() => {
    // Before hydration the setting reads its default, which would remove a registered worker.
    if (!hydrated) return;
    syncInstalledAppServiceWorker(enabled).catch((error: unknown) =>
      console.error("The installed app service worker did not update", error),
    );
  }, [enabled, hydrated]);

  useEffect(() => listenForInstalledAppNotificationClicks(), []);

  return null;
}
