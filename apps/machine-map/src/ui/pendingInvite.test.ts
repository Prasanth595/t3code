import { expect, it } from "vite-plus/test";
import { ClientId, MachineId } from "@t3tools/contracts/machineMap";

import {
  clearPendingInvite,
  invitePasskeyUrl,
  readPendingInvite,
  savePendingInvite,
} from "./pendingInvite.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

it("keeps a phone's name, chosen arrows and map point across the passkey navigation", () => {
  const saved = storage();
  const request = {
    client: { _tag: "new" as const, name: "Pixel", position: { x: -200, y: 1900 } },
    arrows: [{ to: MachineId.make("mac"), level: "read" as const }],
  };
  savePendingInvite(request, true, saved, 1000);
  expect(readPendingInvite(saved, 2000)).toEqual({ request, phone: true, savedAt: 1000 });
  // React StrictMode reads the initial dialog twice; reading must not consume the request.
  expect(readPendingInvite(saved, 2000)?.request).toEqual(request);
  clearPendingInvite(saved);
  expect(readPendingInvite(saved, 2000)).toBeNull();
});

it("expires a saved request and refuses corrupt or future-dated data", () => {
  const saved = storage();
  const request = { client: { _tag: "new" as const, name: "Phone" }, arrows: [] };
  savePendingInvite(request, false, saved, 1000);
  expect(readPendingInvite(saved, 601000)).toBeNull();
  expect(readPendingInvite(saved, 999)).toBeNull();
  expect(readPendingInvite({ getItem: () => "not json" })).toBeNull();
  expect(
    readPendingInvite({ getItem: () => JSON.stringify({ request: {}, savedAt: Date.now() }) }),
  ).toBeNull();
});

it("keeps the existing client id and marks only the invite return for resumption", () => {
  const saved = storage();
  const request = {
    client: { _tag: "existing" as const, clientId: ClientId.make("client-phone") },
    arrows: [],
  };
  savePendingInvite(request, false, saved, 1000);
  expect(readPendingInvite(saved, 2000)?.request).toEqual(request);
  const url = new URL(invitePasskeyUrl("#/clients/client/a b"), "https://portal.example.com");
  expect(url.pathname).toBe("/api/grant/start");
  expect(url.searchParams.get("resume")).toBe("invite");
  expect(url.searchParams.get("then")).toBe("#/clients/client/a b");
});
