/**
 * Fork: native app clients of the machine map (MM-913, MM-914). An invite from
 * the portal gives this app its own Cloudflare Access service token and the
 * machines it may reach. The app keeps the token as request headers for each
 * machine origin and the portal origin, then pairs with each machine through
 * `/api/auth/cloudflare-access/pairing-credential`.
 */
import { AuthPairingCredentialResult, ClientEnrollResponse } from "@t3tools/contracts";
import * as Device from "expo-device";
import * as Schema from "effect/Schema";
import { Platform } from "react-native";

import { fetchWithRequestHeaders } from "./requestHeaders";

export interface ClientInvite {
  readonly enrollUrl: string;
  readonly code: string;
}

/** The invite in `https://<portal>/enroll/client#code=<code>`, or null for any other text. */
export function parseClientInvite(text: string): ClientInvite | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.pathname !== "/enroll/client") return null;
  const code = new URLSearchParams(url.hash.slice(1)).get("code")?.trim() ?? "";
  return code === "" ? null : { enrollUrl: `${url.origin}/enroll/client`, code };
}

// After 404 and 423 the portal deletes any token it made, so a new invite is the only way on.
const ENROLL_ERRORS: Readonly<Record<number, string>> = {
  404: "This invite is unknown, used or cancelled, or its client is gone. Ask for a new invite.",
  410: "This invite expired. Invites last 15 minutes. Ask for a new invite.",
  423: "Everything is paused. Ask for a new invite after Resume.",
  429: "Too many attempts. Wait a minute, then scan again.",
  503: "The portal has no Cloudflare API token, so it cannot make a token for this phone.",
};

const decodeEnrollResponse = Schema.decodeUnknownSync(Schema.toCodecJson(ClientEnrollResponse));
const decodePairingCredential = Schema.decodeUnknownSync(
  Schema.toCodecJson(AuthPairingCredentialResult),
);

function deviceName(): string {
  const model = Device.modelName ?? "Phone";
  return `${model} · ${Platform.OS === "android" ? "Android" : "iOS"} ${Device.osVersion ?? ""}`
    .trim()
    .slice(0, 200);
}

// Before the owner runs "Set up approvals" in the portal, Cloudflare Access
// answers the invite path with its login page instead of the Worker.
function isJsonFromPortal(response: Response): boolean {
  let host = "";
  try {
    host = new URL(response.url).hostname;
  } catch {
    // An empty final URL leaves the content type to decide.
  }
  return (
    !host.endsWith(".cloudflareaccess.com") &&
    (response.headers.get("content-type") ?? "").includes("application/json")
  );
}

/** Uses the invite once. The answer holds the only copy of the token secret. */
export async function redeemClientInvite(invite: ClientInvite): Promise<ClientEnrollResponse> {
  const response = await fetch(invite.enrollUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: invite.code, device: deviceName() }),
  });
  if (!isJsonFromPortal(response)) {
    throw new Error("The portal is not set up for app invites yet. Run Set up approvals in it.");
  }
  if (!response.ok) {
    throw new Error(
      ENROLL_ERRORS[response.status] ?? `The portal refused the invite (${response.status}).`,
    );
  }
  return decodeEnrollResponse(await response.json());
}

/** A one-use pairing credential from a machine. Needs the token headers saved for its origin. */
export async function issueMachinePairingCredential(origin: string): Promise<string> {
  const response = await fetchWithRequestHeaders(
    `${origin}/api/auth/cloudflare-access/pairing-credential`,
    { method: "POST" },
  );
  if (response.status === 401) {
    throw new Error("This machine does not accept app invites yet. Update it.");
  }
  if (!response.ok) throw new Error(`The machine refused this phone (${response.status}).`);
  return decodePairingCredential(await response.json()).credential;
}
