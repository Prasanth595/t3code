import type { ApiError } from "../api.ts";

const isApiError = (value: unknown): value is ApiError =>
  typeof value === "object" &&
  value !== null &&
  "error" in value &&
  typeof value.error === "string";

/** MM-1207: the approval path asks for a fresh passkey check first. */
export class StepUpNeeded extends Error {
  override readonly name = "StepUpNeeded";
  constructor() {
    super("Confirm with your passkey first.");
  }
}

/**
 * Calls the portal API. The response types come from `api.ts`; the portal is the only server.
 * A request without an Access session gets a redirect to sign-in, which fetch reports as a
 * network error.
 */
export async function callApi<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      // Cloudflare Access answers an ended sign-in with a redirect to its login page.
      redirect: "manual",
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error("The portal did not answer. Reload the page to sign in again.");
  }
  if (response.type === "opaqueredirect") {
    if (path.startsWith("/api/grant/")) throw new StepUpNeeded();
    throw new Error("Your sign-in ended. Reload the page to sign in again.");
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(isApiError(data) ? data.error : `The portal answered ${response.status}.`);
  return data as T;
}
