/**
 * Fork: the installed web app, behind the `installedAppEnabled` client setting. It registers
 * `public/sw.js`, shows notifications through the worker where the page cannot, and puts the
 * notification count on the app icon. The desktop app has its own notifications and dock badge.
 */
import { isElectron } from "./env";
import { getClientSettings } from "./hooks/useSettings";

const SERVICE_WORKER_URL = "/sw.js";
const NOTIFICATION_CLICK = "t3code:notification-click";

function supported(): boolean {
  return !isElectron && "serviceWorker" in navigator;
}

/** Registers the worker while the setting is on, and removes it when the setting goes off. */
export async function syncInstalledAppServiceWorker(enabled: boolean): Promise<void> {
  if (!supported()) return;
  if (enabled) {
    await navigator.serviceWorker.register(SERVICE_WORKER_URL);
    return;
  }
  const registration = await navigator.serviceWorker.getRegistration("/");
  await registration?.unregister();
  if ("clearAppBadge" in navigator) await navigator.clearAppBadge().catch(() => undefined);
}

/** The app icon shows the same count as the favicon badge. */
export function setInstalledAppBadge(count: number): void {
  if (!getClientSettings().installedAppEnabled || !("setAppBadge" in navigator)) return;
  // A browser tab without an installed app refuses the badge. Nothing depends on it.
  (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => undefined);
}

// Click actions of worker notifications, by tag. A tag is one thread or one guide run, so a newer
// notification replaces the older action and the map stays as small as the thread list.
const clickActions = new Map<string, () => void>();

/**
 * Android Chrome and iOS refuse `new Notification()` and show notifications only through a
 * service worker. Returns the shown notification, or null when the worker is not active.
 */
export async function showInstalledAppNotification(
  title: string,
  options: { readonly body: string; readonly tag: string; readonly url: string },
  onClick: () => void,
): Promise<Notification | null> {
  if (!supported() || !getClientSettings().installedAppEnabled) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (!registration?.active) return null;
  clickActions.set(options.tag, onClick);
  await registration.showNotification(title, {
    body: options.body,
    tag: options.tag,
    silent: true,
    icon: "/icon-192.png",
    data: options.url,
  });
  const [shown] = await registration.getNotifications({ tag: options.tag });
  return shown ?? null;
}

/** Runs the click action of a worker notification. Returns the cleanup for the listener. */
export function listenForInstalledAppNotificationClicks(): () => void {
  if (!supported()) return () => undefined;
  const onMessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== NOTIFICATION_CLICK ||
      !("tag" in message) ||
      typeof message.tag !== "string"
    ) {
      return;
    }
    const action = clickActions.get(message.tag);
    clickActions.delete(message.tag);
    action?.();
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}
