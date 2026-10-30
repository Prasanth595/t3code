import type { ManagedPolicyDocument } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ManagedLimits from "./managedLimits.ts";
import * as ManagedPolicy from "./ManagedPolicy.ts";

const policy = (limits?: ManagedPolicyDocument["limits"]) => ({
  document: {
    schemaVersion: 1 as const,
    organization: "Example Corp",
    ...(limits === undefined ? {} : { limits }),
  },
});

const desktopAndLocal = policy({ clients: ["desktop", "local-browser"] });

it.effect("refuses to listen on a non-loopback host when remote clients are not allowed", () =>
  Effect.gen(function* () {
    const error = yield* ManagedLimits.checkServerReachability(desktopAndLocal, {
      authPolicy: "remote-reachable",
      host: "0.0.0.0",
      tailscaleServeEnabled: false,
    }).pipe(Effect.flip);
    assert.equal(
      error.message,
      "Example Corp's policy does not allow remote clients, so the server cannot listen on 0.0.0.0.",
    );
  }),
);

it.effect("refuses Tailscale Serve when remote clients are not allowed", () =>
  Effect.gen(function* () {
    const error = yield* ManagedLimits.checkServerReachability(desktopAndLocal, {
      authPolicy: "loopback-browser",
      host: undefined,
      tailscaleServeEnabled: true,
    }).pipe(Effect.flip);
    assert.include(error.message, "Tailscale Serve");
  }),
);

it.effect("refuses an auth policy the clients list leaves out", () =>
  Effect.gen(function* () {
    const error = yield* ManagedLimits.checkServerReachability(policy({ clients: ["desktop"] }), {
      authPolicy: "loopback-browser",
      host: undefined,
      tailscaleServeEnabled: false,
    }).pipe(Effect.flip);
    assert.equal(error.message, "Example Corp's policy does not allow browsers on this machine.");
  }),
);

it.effect("refuses unsafe-no-auth under any policy file, even one without limits", () =>
  Effect.gen(function* () {
    const error = yield* ManagedLimits.checkServerReachability(policy(), {
      authPolicy: "unsafe-no-auth",
      host: undefined,
      tailscaleServeEnabled: false,
    }).pipe(Effect.flip);
    assert.include(error.message, "without authentication");
    assert.isTrue(ManagedLimits.allowsAuthPolicy({ document: undefined }, "unsafe-no-auth"));
  }),
);

it.effect("allows the clients the policy lists", () =>
  ManagedLimits.checkServerReachability(policy({ clients: ["remote"] }), {
    authPolicy: "remote-reachable",
    host: "0.0.0.0",
    tailscaleServeEnabled: true,
  }),
);

it.effect("tells clients Connect is off when the policy leaves out remote clients", () =>
  Effect.gen(function* () {
    const managed = yield* ManagedPolicy.fromDocument("/test/policy.json", {
      ...desktopAndLocal.document,
    });
    assert.deepEqual(managed.summary?.limits, {
      clients: ["desktop", "local-browser"],
      connect: false,
    });
    assert.isTrue(ManagedLimits.allowsConnect(policy({ clients: ["remote"] })));
    assert.isFalse(ManagedLimits.allowsConnect(policy({ connect: false })));
  }),
);
