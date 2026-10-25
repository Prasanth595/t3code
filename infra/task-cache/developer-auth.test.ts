import * as NodeCrypto from "node:crypto";
import { expect, it } from "vite-plus/test";

import { developerIdentity } from "./developer-auth.ts";

const token = "fixture-token-012345678901234567890123456789";
const keys = JSON.stringify({
  julius: NodeCrypto.createHash("sha256").update(token).digest("hex"),
});
const request = (credentials: string) =>
  new Request("https://cache.example/projects/t3code/store", {
    headers: { authorization: `Basic ${btoa(credentials)}` },
  });

it("accepts the registered developer and rejects wrong, revoked, or malformed credentials", async () => {
  expect(await developerIdentity(request(`julius:${token}`), keys)).toBe("julius");
  expect(await developerIdentity(request(`theo:${token}`), keys)).toBeNull();
  expect(await developerIdentity(request(`julius:${token}wrong`), keys)).toBeNull();
  expect(await developerIdentity(request(`julius:${token}`), "{}")).toBeNull();
  expect(await developerIdentity(request(`julius:${token}`), undefined)).toBeNull();
  expect(await developerIdentity(request("malformed"), keys)).toBeNull();
  expect(await developerIdentity(request(`constructor:${token}`), keys)).toBeNull();
});

it("leaves anonymous reads and GitHub OIDC authorization to the upstream Worker", async () => {
  expect(await developerIdentity(new Request("https://cache.example"), keys)).toBeUndefined();
  const oidc = new Request("https://cache.example", {
    headers: { authorization: "Bearer github-oidc-token" },
  });
  expect(await developerIdentity(oidc, keys)).toBeUndefined();
});
