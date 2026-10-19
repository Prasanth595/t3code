import { afterEach, expect, it, vi } from "vite-plus/test";

import { readPushState } from "./PushSettings.tsx";

afterEach(() => vi.unstubAllGlobals());

function browser(subscribed: boolean) {
  const publicKey = "AQID";
  const endpoint = "https://push.example.com/device";
  const unsubscribe = vi.fn(async () => true);
  const subscription = {
    endpoint,
    options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
    unsubscribe,
  };
  vi.stubGlobal("window", { PushManager: {}, Notification: {} });
  vi.stubGlobal("Notification", { permission: "granted" });
  vi.stubGlobal("navigator", {
    serviceWorker: {
      ready: Promise.resolve({ pushManager: { getSubscription: async () => subscription } }),
    },
  });
  const fetch = vi.fn(async (path: string) =>
    Response.json(path === "/api/push" ? { publicKey } : { subscribed }),
  );
  vi.stubGlobal("fetch", fetch);
  return { publicKey, endpoint, fetch, unsubscribe };
}

it("keeps notifications off when sign-out removed the server registration", async () => {
  const { publicKey, endpoint, fetch } = browser(false);
  expect(await readPushState()).toEqual({ _tag: "off", publicKey });
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/push", "/api/push/status"]);
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/push/status",
    expect.objectContaining({
      body: JSON.stringify({ endpoint }),
    }),
  );
});

it("shows an existing registration as on without re-registering it on mount", async () => {
  const { publicKey, endpoint, fetch } = browser(true);
  expect(await readPushState()).toEqual({ _tag: "on", publicKey, endpoint });
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/push", "/api/push/status"]);
});

it("still drops an obsolete browser subscription after the VAPID key changes", async () => {
  const { unsubscribe } = browser(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ publicKey: "BAUG" })),
  );
  expect(await readPushState()).toEqual({ _tag: "off", publicKey: "BAUG" });
  expect(unsubscribe).toHaveBeenCalledOnce();
});
