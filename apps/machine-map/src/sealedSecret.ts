/**
 * MM-1201: token secrets wait for their machine encrypted with AES-GCM. The key is the Worker
 * secret `SECRET_KEY`, 32 random bytes in base64 (`openssl rand -base64 32`).
 */

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function importKey(secretKey: string | undefined): Promise<CryptoKey> {
  if (!secretKey) throw new Error("SECRET_KEY is not set. Joins and rotations need it.");
  const raw = fromBase64(secretKey);
  if (raw.length !== 32) throw new Error("SECRET_KEY must be 32 bytes in base64.");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Returns base64 of the 12-byte IV followed by the ciphertext. */
export async function seal(secretKey: string | undefined, plain: string): Promise<string> {
  const key = await importKey(secretKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  const out = new Uint8Array(iv.length + cipher.byteLength);
  out.set(iv);
  out.set(new Uint8Array(cipher), iv.length);
  return toBase64(out);
}

export async function unseal(secretKey: string | undefined, sealed: string): Promise<string> {
  const key = await importKey(secretKey);
  const bytes = fromBase64(sealed);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12),
  );
  return new TextDecoder().decode(plain);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** A join code like `K7QM-2XPA`: 8 characters without look-alike letters (MM-202). */
export function newJoinCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length] ?? "A").join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** Codes compare without case, spaces or dashes, so a typed code still matches. */
export const normalizeJoinCode = (code: string): string =>
  code.toUpperCase().replaceAll("-", "").replaceAll(" ", "");
