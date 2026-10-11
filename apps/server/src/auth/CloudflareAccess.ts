import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import type { CloudflareAccessConfig } from "../config.ts";

export const CLOUDFLARE_ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

/**
 * Fork: Cloudflare Access login. Cloudflare signs every request that passes
 * Access with a JWT in `Cf-Access-Jwt-Assertion`. This trusts that header only
 * because the server listens on loopback and is reachable through the tunnel
 * alone. Revisit this before the server is exposed directly, because then
 * anybody can send a request without passing Access first.
 *
 * The returned check yields the matched subject (an email, or a service token
 * common name) or `undefined`. Every unexpected state fails closed.
 */
export const makeCloudflareAccessVerifier = (
  config: CloudflareAccessConfig,
  // createRemoteJWKSet caches the keys and refetches once on an unknown kid.
  getKey: JWTVerifyGetKey = createRemoteJWKSet(
    new URL(`https://${config.teamDomain}/cdn-cgi/access/certs`),
  ),
) => {
  const subjects = new Set(config.subjects);
  return (request: HttpServerRequest.HttpServerRequest): Effect.Effect<string | undefined> => {
    const token = request.headers[CLOUDFLARE_ACCESS_JWT_HEADER];
    if (typeof token !== "string" || token.length === 0) {
      return Effect.succeed(undefined);
    }
    return Effect.tryPromise(() =>
      jwtVerify(token, getKey, {
        issuer: `https://${config.teamDomain}`,
        audience: config.aud,
        algorithms: ["RS256"],
        requiredClaims: ["exp"],
        clockTolerance: 5,
      }),
    ).pipe(
      Effect.map(({ payload }) => {
        const email = typeof payload.email === "string" ? payload.email : undefined;
        const commonName =
          typeof payload.common_name === "string" ? payload.common_name : undefined;
        return [email, commonName].find(
          (candidate) => candidate !== undefined && subjects.has(candidate),
        );
      }),
      Effect.tap((subject) =>
        subject === undefined
          ? Effect.logWarning("Cloudflare Access JWT subject is not in the allowed list.")
          : Effect.void,
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Rejected Cloudflare Access JWT.", { cause: String(cause) }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
  };
};
