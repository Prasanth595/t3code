import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import {
  listenForInstalledAppNotificationClicks,
  syncInstalledAppServiceWorker,
} from "../installedApp";
import { useConnectedEnvironmentIds } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { webPushPublicKey, webPushSubscribe } from "../state/webPush";
import { removePushRegistrations, subscribeEnvironment, webPushWanted } from "../webPush";

/**
 * Fork: keeps the service worker of the installed web app in step with `installedAppEnabled`,
 * and the Web Push subscription of each environment in step with `webPushEnabled`.
 */
export function InstalledAppCoordinator() {
  const hydrated = useClientSettingsHydrated();
  const enabled = useClientSettings((settings) => settings.installedAppEnabled);
  const webPushEnabled = useClientSettings((settings) => settings.webPushEnabled);
  const notificationMode = useClientSettings((settings) => settings.notificationMode);
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const readPublicKey = useAtomCommand(webPushPublicKey, { reportFailure: false });
  const saveSubscription = useAtomCommand(webPushSubscribe, { reportFailure: false });
  const navigate = useNavigate();

  useEffect(() => {
    // Before hydration the setting reads its default, which would remove a registered worker.
    if (!hydrated) return;
    syncInstalledAppServiceWorker(enabled).catch((error: unknown) =>
      console.error("The installed app service worker did not update", error),
    );
  }, [enabled, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const wanted = webPushWanted({
      installedAppEnabled: enabled,
      webPushEnabled,
      notificationMode,
    });
    // Each connection runs this again. The server writes only a changed subscription.
    // The push worker of a removed environment stays, and its server can still push here. The
    // environment list is empty for a moment at each page load, so it cannot decide a removal.
    // Revisit if removed environments still notify.
    const sync = async () => {
      if (!wanted) {
        await removePushRegistrations();
        return;
      }
      for (const environmentId of connectedEnvironmentIds) {
        const key = await readPublicKey({ environmentId, input: {} });
        if (key._tag === "Failure") {
          console.warn("Web Push: the environment gave no key", environmentId, key.cause);
          continue;
        }
        const subscription = await subscribeEnvironment(environmentId, key.value.publicKey);
        await saveSubscription({
          environmentId,
          input: { subscription, origin: window.location.origin },
        });
      }
    };
    sync().catch((error: unknown) => console.error("Web Push did not update", error));
  }, [
    connectedEnvironmentIds,
    enabled,
    hydrated,
    notificationMode,
    readPublicKey,
    saveSubscription,
    webPushEnabled,
  ]);

  // A push notification has no click action in the page, so its click opens its path.
  useEffect(
    () => listenForInstalledAppNotificationClicks((url) => void navigate({ href: url })),
    [navigate],
  );

  return null;
}
