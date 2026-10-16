/**
 * Fork: Web Push, behind the `webPushEnabled` client setting. A push subscription can use the key
 * of one server only, so this browser registers `public/sw.js` once per environment, with the
 * scope `/push/<environmentId>/`. No page lives there: these workers only receive pushes.
 */
import type { ClientSettings, EnvironmentId, WebPushSubscription } from "@t3tools/contracts";

import { isElectron } from "./env";
import { hasDesktopNotifications } from "./threadNotifications";

const SERVICE_WORKER_URL = "/sw.js";
const PUSH_SCOPE_PATH = "/push/";

const scopeFor = (environmentId: EnvironmentId) =>
  new URL(`${PUSH_SCOPE_PATH}${encodeURIComponent(environmentId)}/`, window.location.origin).href;

export function webPushSupported(): boolean {
  return !isElectron && "serviceWorker" in navigator && "PushManager" in window;
}

/** Push needs the installed app, system notifications, and the permission of the browser. */
export function webPushWanted(
  settings: Pick<ClientSettings, "installedAppEnabled" | "webPushEnabled" | "notificationMode">,
): boolean {
  return (
    webPushSupported() &&
    settings.installedAppEnabled &&
    settings.webPushEnabled &&
    hasDesktopNotifications(settings.notificationMode) &&
    Notification.permission === "granted"
  );
}

async function activeRegistration(environmentId: EnvironmentId) {
  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
    scope: scopeFor(environmentId),
  });
  const worker = registration.installing ?? registration.waiting;
  if (!registration.active && worker) {
    await new Promise<void>((resolve) => {
      const onChange = () => {
        if (worker.state !== "activated" && worker.state !== "redundant") return;
        worker.removeEventListener("statechange", onChange);
        resolve();
      };
      worker.addEventListener("statechange", onChange);
    });
  }
  return registration;
}

function toWire(subscription: PushSubscription): WebPushSubscription {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) {
    throw new Error("The push subscription has no endpoint or keys.");
  }
  return { endpoint: json.endpoint, p256dh, auth };
}

const toBase64Url = (buffer: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/** The subscription of this browser for one environment, made with that environment's key. */
export async function subscribeEnvironment(
  environmentId: EnvironmentId,
  publicKey: string,
): Promise<WebPushSubscription> {
  const registration = await activeRegistration(environmentId);
  const existing = await registration.pushManager.getSubscription();
  const existingKey = existing?.options.applicationServerKey;
  if (existing && existingKey && toBase64Url(existingKey) === publicKey) return toWire(existing);
  // A new server key (a reinstalled server) needs a new subscription.
  await existing?.unsubscribe();
  return toWire(
    await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: publicKey,
    }),
  );
}

/** The subscription endpoint of this browser for one environment, or null. */
export async function environmentEndpoint(environmentId: EnvironmentId): Promise<string | null> {
  if (!webPushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration(scopeFor(environmentId));
  return (await registration?.pushManager.getSubscription())?.endpoint ?? null;
}

/**
 * Removes every push worker of this browser. The servers delete a subscription when the push
 * service answers that it is gone.
 */
export async function removePushRegistrations(): Promise<void> {
  if (!webPushSupported()) return;
  const pushScope = new URL(PUSH_SCOPE_PATH, window.location.origin).href;
  for (const registration of await navigator.serviceWorker.getRegistrations()) {
    if (!registration.scope.startsWith(pushScope)) continue;
    await (await registration.pushManager.getSubscription())?.unsubscribe();
    await registration.unregister();
  }
}
