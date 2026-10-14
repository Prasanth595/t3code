/** MM-1809: turns push notifications on or off for this device. */
import { useEffect, useState } from "react";

import type { PushKeyResponse } from "../api.ts";
import { callApi } from "./apiClient.ts";
import { usePortalContext } from "./context.ts";

type PushState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "unavailable"; readonly reason: string }
  | { readonly _tag: "denied" }
  | { readonly _tag: "off"; readonly publicKey: string }
  | { readonly _tag: "on"; readonly publicKey: string; readonly endpoint: string };

const toBase64Url = (buffer: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

function unsupportedReason(): string | null {
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) {
    return null;
  }
  // iOS gives Web Push only to an app on the Home Screen.
  return /iPhone|iPad/.test(navigator.userAgent)
    ? "Add the portal to the Home Screen with Share > Add to Home Screen. Then open it from there."
    : "This browser has no Web Push.";
}

/** Sends the subscription to the portal again, so the portal always has the current keys. */
const register = (subscription: PushSubscription) =>
  callApi("POST", "/api/push/subscribe", subscription.toJSON());

async function readState(): Promise<PushState> {
  const reason = unsupportedReason();
  if (reason) return { _tag: "unavailable", reason };
  const { publicKey } = await callApi<PushKeyResponse>("GET", "/api/push");
  if (publicKey === null) {
    return {
      _tag: "unavailable",
      reason: "The portal has no VAPID_JWK secret yet. The README says how to add it.",
    };
  }
  if (Notification.permission === "denied") return { _tag: "denied" };
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return { _tag: "off", publicKey };
  const key = subscription.options.applicationServerKey;
  // A new VAPID key makes old subscriptions useless: the push service refuses their messages.
  if (key === null || toBase64Url(key) !== publicKey) {
    await subscription.unsubscribe();
    return { _tag: "off", publicKey };
  }
  await register(subscription);
  return { _tag: "on", publicKey, endpoint: subscription.endpoint };
}

export function PushSettings() {
  const portal = usePortalContext();
  const [state, setState] = useState<PushState>({ _tag: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    readState()
      .then((next) => current && setState(next))
      .catch(
        (error: unknown) =>
          current &&
          setState({
            _tag: "unavailable",
            reason: error instanceof Error ? error.message : String(error),
          }),
      );
    return () => {
      current = false;
    };
  }, []);

  const run = (work: () => Promise<PushState>, done: string) => {
    setBusy(true);
    portal.call(async () => {
      try {
        setState(await work());
        return done;
      } finally {
        setBusy(false);
      }
    });
  };

  const turnOn = (publicKey: string) =>
    run(async () => {
      // iOS asks only from a tap, so the request stays in this click handler.
      const permission = await Notification.requestPermission();
      if (permission === "denied") return { _tag: "denied" };
      if (permission !== "granted") return { _tag: "off", publicKey };
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: fromBase64Url(publicKey),
      });
      await register(subscription);
      return { _tag: "on", publicKey, endpoint: subscription.endpoint };
    }, "Notifications are on for this device.");

  const turnOff = (publicKey: string, endpoint: string) =>
    run(async () => {
      const registration = await navigator.serviceWorker.ready;
      await (await registration.pushManager.getSubscription())?.unsubscribe();
      await callApi("POST", "/api/push/unsubscribe", { endpoint });
      return { _tag: "off", publicKey };
    }, "Notifications are off for this device.");

  return (
    <>
      <h3>Notifications on this device</h3>
      <p className="small muted">
        Health alerts, a machine that is down, new Inbox proposals and the emergency pause.
      </p>
      {state._tag === "loading" && <p className="small muted">Checking…</p>}
      {state._tag === "unavailable" && <p className="small muted">{state.reason}</p>}
      {state._tag === "denied" && (
        <p className="small muted">
          The browser blocks notifications for the portal. Allow them in the site settings of the
          browser, then reload.
        </p>
      )}
      {state._tag === "off" && (
        <div className="actions">
          <span className="sticker none">off</span>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => turnOn(state.publicKey)}
          >
            Turn on
          </button>
        </div>
      )}
      {state._tag === "on" && (
        <div className="actions">
          <span className="sticker ok">on</span>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              portal.call(() =>
                callApi<string>("POST", "/api/push/test", { endpoint: state.endpoint }),
              )
            }
          >
            Send a test
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => turnOff(state.publicKey, state.endpoint)}
          >
            Turn off
          </button>
        </div>
      )}
    </>
  );
}
