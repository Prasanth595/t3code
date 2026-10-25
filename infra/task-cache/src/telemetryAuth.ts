import { decodeJwt, type JWTVerifyGetKey } from "jose";
import { authorize } from "../vendor/vite-plus-remote-cache-cloudflare/src/auth.ts";
import type { Scope } from "../vendor/vite-plus-remote-cache-cloudflare/src/database.ts";
import { HttpError } from "../vendor/vite-plus-remote-cache-cloudflare/src/errors.ts";

export async function authorizeTelemetry(request: Request, scope: Scope, keys: JWTVerifyGetKey) {
  const authorization = request.headers.get("authorization");
  if (!authorization || authorization.length > 16 * 1024) throw new HttpError(401, "invalid_token");
  let payload;
  try {
    payload = decodeJwt(authorization.slice(7));
  } catch {
    throw new HttpError(401, "invalid_token");
  }
  // Reports grant no artifact writes. Any PR base in this repository may report;
  // authorize still verifies the signature, issuer, audience, repository and owner.
  const branch =
    payload.event_name === "pull_request" && typeof payload.base_ref === "string"
      ? `refs/heads/${payload.base_ref}`
      : scope.branch;
  await authorize(request, { ...scope, branch, writes_enabled: 1, pull_requests: 1 }, keys);
  return `github/${typeof payload.actor === "string" ? payload.actor : "unknown"}`;
}
