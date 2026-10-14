// Fork: the service worker of the installed web app (client setting `installedAppEnabled`,
// registered by `src/installedApp.ts`). It caches only the offline page. Pages and build files
// come from the network and the HTTP cache, so a new server build shows at once and a Cloudflare
// Access redirect reaches the browser. RPC and WebSocket traffic never passes through it.

const CACHE = "t3code-offline-v1";
const OFFLINE_PAGE = "/offline.html";
// A Cloudflare tunnel whose T3 server is down answers with one of these.
const UNREACHABLE_STATUSES = new Set([502, 503, 504, 530]);

self.addEventListener("install", (event) => {
  // Requests other than page loads skip this worker, where the browser supports static routes.
  if (event.addRoutes) {
    event
      .addRoutes({ condition: { not: { requestMode: "navigate" } }, source: "network" })
      .catch(() => undefined);
  }
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(OFFLINE_PAGE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.registration.navigationPreload?.enable();
      await self.clients.claim();
    })(),
  );
});

async function offlinePage() {
  const page = await caches.match(OFFLINE_PAGE);
  if (!page) throw new Error("The offline page is not in the cache.");
  return page;
}

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate" || event.request.method !== "GET") return;
  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        const response = preloaded instanceof Response ? preloaded : await fetch(event.request);
        return UNREACHABLE_STATUSES.has(response.status) ? await offlinePage() : response;
      } catch {
        return offlinePage();
      }
    })(),
  );
});

// Notifications come from `showInstalledAppNotification`. A click focuses an open window and
// hands the tag back, so the page runs the same click action as a page notification.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { tag } = event.notification;
  const data = event.notification.data;
  const url = typeof data === "string" && data.startsWith("/") ? data : "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window" });
      if (windows.length === 0) {
        await self.clients.openWindow(url);
        return;
      }
      const target = windows.find((client) => client.focused) ?? windows[0];
      await target.focus();
      for (const client of windows) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- `Client.postMessage` has no target origin. The clients of a worker share its origin.
        client.postMessage({ type: "t3code:notification-click", tag });
      }
    })(),
  );
});
