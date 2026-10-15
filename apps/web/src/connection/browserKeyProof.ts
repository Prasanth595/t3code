/**
 * Fork (MM-917): a DPoP proof with the browser key, so a machine can find the client of this
 * browser when it signs in through Cloudflare Access. The key is the one the relay uses; its
 * private part never leaves the browser. A failure gives no proof, and the sign-in then keeps the
 * owner access while machines only observe keys.
 *
 * Known limit: the relay and this module can each make the key on the very first use, and the
 * later write wins. The browser then shows one more waiting key. Revisit if a browser shows two.
 */
import * as Effect from "effect/Effect";

import {
  type BrowserDpopKey,
  createBrowserDpopProof,
  generateBrowserDpopKey,
  layer as browserCryptoLayer,
  readStoredBrowserDpopKey,
  writeStoredBrowserDpopKey,
} from "../cloud/dpop";

let loadedKey: Promise<BrowserDpopKey> | null = null;

const loadOrCreateKey = (): Promise<BrowserDpopKey> =>
  (loadedKey ??= Effect.runPromise(
    Effect.gen(function* () {
      const stored = yield* readStoredBrowserDpopKey();
      if (stored) return stored;
      const generated = yield* generateBrowserDpopKey;
      yield* writeStoredBrowserDpopKey(generated);
      return generated;
    }).pipe(Effect.provide(browserCryptoLayer)),
  ));

/** The DPoP proof for one request, or null when this browser cannot make one. */
export async function browserKeyProof(method: string, url: string): Promise<string | null> {
  try {
    const proofKey = await loadOrCreateKey();
    const { proof } = await Effect.runPromise(
      createBrowserDpopProof({ method, url, proofKey }).pipe(Effect.provide(browserCryptoLayer)),
    );
    return proof;
  } catch {
    loadedKey = null;
    return null;
  }
}
