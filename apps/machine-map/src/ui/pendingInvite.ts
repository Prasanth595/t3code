import * as Schema from "effect/Schema";

import { InviteRequest } from "../api.ts";

const KEY = "machine-map:pending-invite";
const MAX_AGE_MS = 10 * 60_000;
const PendingInvite = Schema.Struct({
  request: InviteRequest,
  phone: Schema.Boolean,
  savedAt: Schema.Number,
});
const decode = Schema.decodeUnknownSync(PendingInvite);

/** Keep only the owner's request across Cloudflare, never an invite code or token. */
export function savePendingInvite(
  request: InviteRequest,
  phone: boolean,
  storage: Pick<Storage, "setItem"> = sessionStorage,
  now = Date.now(),
) {
  storage.setItem(KEY, JSON.stringify({ request, phone, savedAt: now }));
}

export function readPendingInvite(
  storage: Pick<Storage, "getItem"> = sessionStorage,
  now = Date.now(),
) {
  try {
    const saved = storage.getItem(KEY);
    if (!saved) return null;
    const pending = decode(JSON.parse(saved));
    const age = now - pending.savedAt;
    return age >= 0 && age < MAX_AGE_MS ? pending : null;
  } catch {
    return null;
  }
}

export function clearPendingInvite(storage: Pick<Storage, "removeItem"> = sessionStorage) {
  storage.removeItem(KEY);
}

export const invitePasskeyUrl = (hash: string) =>
  `/api/grant/start?resume=invite&then=${encodeURIComponent(hash)}`;
