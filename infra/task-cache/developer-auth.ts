// Vite Task's HTTP client supports Basic authentication in its endpoint URL.
// Keep only token digests on the Worker; credentials stay outside the checkout.
export async function developerIdentity(request: Request, encodedKeys: string | undefined) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.toLowerCase().startsWith("basic ")) return undefined;
  if (!encodedKeys || authorization.length > 1024) return null;

  let credentials: string;
  let keys: Record<string, string>;
  try {
    credentials = atob(authorization.slice(6));
    keys = JSON.parse(encodedKeys);
  } catch {
    return null;
  }
  const separator = credentials.indexOf(":");
  const name = credentials.slice(0, separator);
  const token = credentials.slice(separator + 1);
  if (separator < 1 || !/^[a-z0-9-]{1,64}$/.test(name) || token.length < 32) return null;
  const expected = Object.hasOwn(keys, name) ? keys[name] : undefined;
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) return null;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  let difference = 0;
  for (let index = 0; index < actual.length; index++) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0 ? name : null;
}
