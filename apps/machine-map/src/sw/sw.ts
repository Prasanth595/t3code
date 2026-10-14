/**
 * The service worker of the installed portal (MM-1801 to MM-1804, MM-1808). It caches only the files of
 * one build. Pages always come from the network, so a Cloudflare Access redirect reaches the
 * browser, and machine state never comes from a cache.
 */
import type { PushMessage } from "../api.ts";

declare const self: ServiceWorkerGlobalScope;

/** `vite.config.ts` puts the files of the build here, so each deploy makes a new worker. */
const BUILD_FILES: ReadonlyArray<string> = ["__BUILD_FILES__"];
/** Workers Static Assets serve `offline.html` here. A redirected response cannot answer a navigation. */
const OFFLINE_PAGE = "/offline";
const CACHE = "shell";
const CACHED = new Set([...BUILD_FILES, OFFLINE_PAGE, "/favicon.svg"]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([...CACHED]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Files of older builds leave the cache. Their hashed names never come back.
      const cache = await caches.open(CACHE);
      const old = (await cache.keys()).filter((r) => !CACHED.has(new URL(r.url).pathname));
      await Promise.all(old.map((r) => cache.delete(r)));
      await self.registration.navigationPreload.enable();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.mode === "navigate") {
    // MM-1803, MM-1804: the page comes from the network with its redirects, for example to the
    // Access sign-in. Only a network failure shows the offline page.
    event.respondWith(
      (async () => {
        try {
          const preloaded: unknown = await event.preloadResponse;
          return preloaded instanceof Response ? preloaded : await fetch(request);
        } catch {
          const offline = await caches.match(OFFLINE_PAGE);
          if (!offline) throw new Error("The offline page is not in the cache.");
          return offline;
        }
      })(),
    );
    return;
  }
  const url = new URL(request.url);
  // MM-1802: files of this build only. The API, `/connect` and `/cdn-cgi` always go to the network.
  if (url.origin !== self.location.origin || !CACHED.has(url.pathname)) return;
  event.respondWith(caches.match(url.pathname).then((hit) => hit ?? fetch(request)));
});

const FALLBACK: PushMessage = {
  title: "T3 machines",
  body: "Something needs you.",
  url: "/",
  tag: "fallback",
  badge: 0,
};

/** The portal sends the message. A broken one still shows, because a push must show something. */
function readPush(data: PushMessageData | null): PushMessage {
  try {
    const value: unknown = data?.json();
    if (
      typeof value === "object" &&
      value !== null &&
      "title" in value &&
      typeof value.title === "string" &&
      "body" in value &&
      typeof value.body === "string" &&
      "url" in value &&
      typeof value.url === "string" &&
      value.url.startsWith("/") &&
      "tag" in value &&
      typeof value.tag === "string" &&
      "badge" in value &&
      typeof value.badge === "number"
    ) {
      return {
        title: value.title,
        body: value.body,
        url: value.url,
        tag: value.tag,
        badge: value.badge,
      };
    }
  } catch {
    // Not JSON. The fallback shows.
  }
  return FALLBACK;
}

/** MM-1808: one notification per push, and the badge count of MM-1805 on the app icon. */
self.addEventListener("push", (event) => {
  const message = readPush(event.data);
  // A browser without the Badging API has no `setAppBadge`. The notification still shows.
  const badge = !("setAppBadge" in self.navigator)
    ? Promise.resolve()
    : message.badge > 0
      ? self.navigator.setAppBadge(message.badge)
      : self.navigator.clearAppBadge();
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(message.title, {
        body: message.body,
        tag: message.tag,
        icon: "/icon-192.png",
        data: message.url,
      }),
      // An app that is not installed refuses the badge.
      badge.catch(() => undefined),
    ]),
  );
});

/** A tap opens the path of the message in the open portal window, or in a new one. */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data: unknown = event.notification.data;
  const url = new URL(typeof data === "string" ? data : "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const [open] = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (!open) {
        await self.clients.openWindow(url);
        return;
      }
      await open.focus();
      await open.navigate(url);
    })(),
  );
});
