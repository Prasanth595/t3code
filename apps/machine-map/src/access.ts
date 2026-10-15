/**
 * Cloudflare Access checks (MM-102, MM-104). Every route fails closed: a missing, invalid or
 * unconfigured check refuses the request.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import type { Env } from "./env.ts";

const keySets = new Map<string, JWTVerifyGetKey>();

const keySet = (teamDomain: string): JWTVerifyGetKey => {
  let keys = keySets.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    keySets.set(teamDomain, keys);
  }
  return keys;
};

/** Placeholder values in `wrangler.jsonc` start with this text. */
const PLACEHOLDER = "REPLACE_";
export const configured = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0 && !value.startsWith(PLACEHOLDER);

const decodeOwnerClaims = Schema.decodeUnknownOption(Schema.Struct({ email: Schema.String }));
const decodeMachineClaims = Schema.decodeUnknownOption(
  Schema.Struct({ common_name: Schema.String.check(Schema.isNonEmpty()) }),
);

async function verify(request: Request, env: Env, audience: string | undefined): Promise<unknown> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !configured(audience) || !configured(env.TEAM_DOMAIN)) return null;
  try {
    const { payload } = await jwtVerify(token, keySet(env.TEAM_DOMAIN), {
      issuer: `https://${env.TEAM_DOMAIN}`,
      audience,
      algorithms: ["RS256"],
    });
    return payload;
  } catch {
    return null;
  }
}

/**
 * Local development only: `wrangler dev --var DEV_FAKE_ACCESS:1` on a loopback hostname skips
 * the JWT. Production never has the variable, and its hostname is never loopback.
 */
const fakeAccess = (request: Request, env: Env): boolean => {
  const { hostname } = new URL(request.url);
  return env.DEV_FAKE_ACCESS === "1" && (hostname === "localhost" || hostname === "127.0.0.1");
};

export const ownerEmails = (env: Env): ReadonlyArray<string> =>
  env.OWNER_EMAILS.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);

/** The owner email of a page or API request, or null when the request is not the owner's. */
export async function ownerEmail(request: Request, env: Env): Promise<string | null> {
  if (fakeAccess(request, env)) return ownerEmails(env)[0] ?? null;
  const claims = decodeOwnerClaims(await verify(request, env, env.PAGE_AUD));
  if (Option.isNone(claims)) return null;
  const email = claims.value.email.trim().toLowerCase();
  return ownerEmails(env).includes(email) ? email : null;
}

const decodeApprovalClaims = Schema.decodeUnknownOption(
  Schema.Struct({ email: Schema.String, iat: Schema.Number }),
);
/** Clock difference between Cloudflare and the Worker that the `iat` check allows. */
const CLOCK_SKEW_SECONDS = 30;

/**
 * MM-1207: the owner email of a request on the approval path, or null. The JWT must come from the
 * approvals app (`aud`) and be at most `maxAgeSeconds` old. Its MFA then happened in that time,
 * because the app session and its MFA session have the same length (MM-1208).
 */
export async function approvalEmail(
  request: Request,
  env: Env,
  aud: string | null,
  maxAgeSeconds: number,
): Promise<string | null> {
  if (fakeAccess(request, env)) return ownerEmails(env)[0] ?? null;
  if (aud === null) return null;
  const claims = decodeApprovalClaims(await verify(request, env, aud));
  if (Option.isNone(claims)) return null;
  const age = Date.now() / 1000 - claims.value.iat;
  if (age > maxAgeSeconds + CLOCK_SKEW_SECONDS || age < -CLOCK_SKEW_SECONDS) return null;
  const email = claims.value.email.trim().toLowerCase();
  return ownerEmails(env).includes(email) ? email : null;
}

/**
 * MM-914: the client id of the service token that signed a `/client` request, or null. Its Access
 * app lets in any token of the account; the portal then checks that a client holds it.
 */
export async function clientTokenId(
  request: Request,
  env: Env,
  aud: string | null,
): Promise<string | null> {
  if (fakeAccess(request, env)) return request.headers.get("X-Dev-Client-Token-Id");
  if (aud === null) return null;
  const claims = decodeMachineClaims(await verify(request, env, aud));
  return Option.isSome(claims) ? claims.value.common_name : null;
}

/** The client id of the machine token that signed a `/connect` request, or null. */
export async function machineClientId(request: Request, env: Env): Promise<string | null> {
  if (fakeAccess(request, env)) return request.headers.get("X-Dev-Machine-Client-Id");
  const claims = decodeMachineClaims(await verify(request, env, env.CONNECT_AUD));
  return Option.isSome(claims) ? claims.value.common_name : null;
}
