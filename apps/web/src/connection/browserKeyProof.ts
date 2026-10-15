/**
 * Fork (MM-917): a DPoP proof with the browser key, so a machine can find the client of this
 * browser when it signs in through Cloudflare Access. The key is the one the relay uses; its
 * private part never leaves the browser. A failure gives no proof: the sign-in then keeps the owner
 * access under `observe`, and waits for approval under `enforce` (MM-918).
 */
import * as Effect from "effect/Effect";

import {
  createBrowserDpopProof,
  layer as browserCryptoLayer,
  loadOrCreateBrowserDpopKey,
} from "../cloud/dpop";

/** A slow IndexedDB must not hold up the page start. A sign-in without a proof is as above. */
const PROOF_TIMEOUT_MS = 1_000;

async function makeProof(method: string, url: string): Promise<string | null> {
  try {
    const { proof } = await Effect.runPromise(
      loadOrCreateBrowserDpopKey.pipe(
        Effect.flatMap((proofKey) => createBrowserDpopProof({ method, url, proofKey })),
        Effect.provide(browserCryptoLayer),
      ),
    );
    return proof;
  } catch {
    return null;
  }
}

/** The DPoP proof for one request, or null when this browser cannot make one in time. */
export function browserKeyProof(method: string, url: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    makeProof(method, url),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PROOF_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}
