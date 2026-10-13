import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import { CLOUDFLARE_ACCESS_JWT_HEADER, makeCloudflareAccessVerifier } from "./CloudflareAccess.ts";

const config = {
  teamDomain: "team.cloudflareaccess.com",
  aud: "aud-tag",
  subjects: ["dev@example.com", "client.access"],
};

const makeKeys = Effect.promise(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "key-1", alg: "RS256" };
  return { privateKey, getKey: createLocalJWKSet({ keys: [jwk] }) };
});

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

const sign = (
  privateKey: PrivateKey,
  claims: Record<string, unknown>,
  overrides?: { readonly issuer?: string; readonly audience?: string; readonly exp?: string },
) =>
  Effect.promise(() =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setIssuer(overrides?.issuer ?? "https://team.cloudflareaccess.com")
      .setAudience(overrides?.audience ?? "aud-tag")
      .setIssuedAt()
      .setExpirationTime(overrides?.exp ?? "5m")
      .sign(privateKey),
  );

const requestWith = (token: string | undefined) =>
  HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1/api/auth/session", {
      headers: token === undefined ? {} : { [CLOUDFLARE_ACCESS_JWT_HEADER]: token },
    }),
  );

it.effect("accepts an Access JWT whose email or service token name is allowed", () =>
  Effect.gen(function* () {
    const { privateKey, getKey } = yield* makeKeys;
    const verify = makeCloudflareAccessVerifier(config, getKey);
    const user = yield* sign(privateKey, { email: "dev@example.com" });
    const serviceToken = yield* sign(privateKey, { common_name: "client.access" });
    expect(yield* verify(requestWith(user))).toEqual({ kind: "owner", subject: "dev@example.com" });
    expect(yield* verify(requestWith(serviceToken))).toEqual({
      kind: "owner",
      subject: "client.access",
    });
  }),
);

it.effect("names another service token without making it an owner", () =>
  Effect.gen(function* () {
    const { privateKey, getKey } = yield* makeKeys;
    const verify = makeCloudflareAccessVerifier(config, getKey);
    const machineToken = yield* sign(privateKey, { common_name: "machine.access" });
    expect(yield* verify(requestWith(machineToken))).toEqual({
      kind: "service-token",
      commonName: "machine.access",
    });
  }),
);

it.effect("rejects a missing, foreign, expired or unlisted Access JWT", () =>
  Effect.gen(function* () {
    const { privateKey, getKey } = yield* makeKeys;
    const other = yield* makeKeys;
    const verify = makeCloudflareAccessVerifier(config, getKey);
    const claims = { email: "dev@example.com" };
    const rejected = [
      undefined,
      "not-a-jwt",
      yield* sign(other.privateKey, claims),
      yield* sign(privateKey, claims, { issuer: "https://other.cloudflareaccess.com" }),
      yield* sign(privateKey, claims, { audience: "other-aud" }),
      yield* sign(privateKey, claims, { exp: "-1m" }),
      yield* sign(privateKey, { email: "someone@example.com" }),
    ];
    for (const token of rejected) {
      expect(yield* verify(requestWith(token))).toBeUndefined();
    }
  }),
);
