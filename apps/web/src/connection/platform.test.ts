import {
  AuthStandardClientScopes,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";

import {
  canRetainCachedPlatformRegistrationAfterRefreshFailure,
  canReuseCachedPlatformRegistration,
  isRejectedBootstrapCredentialError,
  isRejectedSecondaryBootstrap,
  makeDesktopSshEnvironmentGateway,
  nextRejectedSecondaryBootstrap,
  primaryRegistrationToRetainAfterTopologyRead,
  readPrimaryEnvironmentTargetResult,
  secondaryRegistrationsToRetainAfterTopologyRead,
  secondaryBearerExpiresAtEpochMs,
  secondaryBearerRefreshAtEpochMs,
} from "./platform.ts";

const TARGET: DesktopSshEnvironmentTarget = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "developer",
  port: 22,
};

const ENVIRONMENT_ID = EnvironmentId.make("environment-ssh");

const OTHER_ENVIRONMENT_ID = EnvironmentId.make("some-other-machine");

const PREPARE_INPUT = {
  connectionId: "ssh:environment-ssh:devbox",
  expectedEnvironmentId: ENVIRONMENT_ID,
  target: TARGET,
};

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

// Runs the attempt up to its desktop setup call before the test continues.
const FORK_NOW = { startImmediately: true } as const;

const bearerFor = (environmentId: EnvironmentId) => `bearer-for-${environmentId}`;

interface FakeSshHost {
  /** Bridge calls in order: `ensure` pairs, `tunnel` does not. */
  readonly calls: string[];
  /** Every setup promise the desktop returned. */
  readonly setups: Promise<unknown>[];
  readonly bridge: DesktopBridge;
}

function makeSshHost(options?: {
  readonly failDescriptor?: boolean;
  readonly environmentId?: () => EnvironmentId;
  readonly authenticated?: boolean;
  /** Settles when the desktop finishes the given setup call (0-based). */
  readonly setupDone?: (call: number) => Promise<void>;
}): FakeSshHost {
  const calls: string[] = [];
  const setups: Promise<unknown>[] = [];
  const currentEnvironment = () => options?.environmentId?.() ?? ENVIRONMENT_ID;
  const bridge = {
    ensureSshEnvironment: (
      target: DesktopSshEnvironmentTarget,
      ensureOptions?: { readonly issuePairingToken?: boolean },
    ) => {
      const issuePairingToken = ensureOptions?.issuePairingToken === true;
      const call = setups.length;
      calls.push(issuePairingToken ? "ensure" : "tunnel");
      const setup = (options?.setupDone?.(call) ?? Promise.resolve()).then(() => ({
        target,
        httpBaseUrl: "http://127.0.0.1:3201/",
        wsBaseUrl: "ws://127.0.0.1:3201/",
        pairingToken: issuePairingToken ? "pairing-token" : null,
      }));
      setups.push(setup);
      return setup;
    },
    fetchSshEnvironmentDescriptor: async () => {
      calls.push("descriptor");
      if (options?.failDescriptor === true) {
        throw new Error("descriptor unavailable");
      }
      return {
        environmentId: currentEnvironment(),
        label: "SSH environment",
        platform: {
          os: "linux",
          arch: "x64",
        },
        serverVersion: "0.0.0-test",
        capabilities: {
          repositoryIdentity: true,
        },
      };
    },
    fetchSshSessionState: async (_httpBaseUrl: string, bearerToken: string) => {
      calls.push("session");
      return {
        authenticated:
          (options?.authenticated ?? true) && bearerToken === bearerFor(currentEnvironment()),
      };
    },
    bootstrapSshBearerSession: async () => {
      calls.push("token");
      return {
        access_token: bearerFor(currentEnvironment()),
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: AuthStandardClientScopes.join(" "),
      };
    },
  } as unknown as DesktopBridge;
  return { calls, setups, bridge };
}

describe("desktop SSH pairing", () => {
  it.effect("fetches the descriptor before consuming the one-time credential", () =>
    Effect.gen(function* () {
      const host = makeSshHost();

      const provisioned = yield* makeDesktopSshEnvironmentGateway(() => host.bridge).provision(
        TARGET,
      );

      expect(provisioned.environmentId).toBe(ENVIRONMENT_ID);
      expect(host.calls).toEqual(["ensure", "descriptor", "token"]);
    }),
  );

  it.effect("does not consume the credential when adding a route to a different machine", () =>
    Effect.gen(function* () {
      const host = makeSshHost();

      const error = yield* makeDesktopSshEnvironmentGateway(() => host.bridge)
        .provision(TARGET, OTHER_ENVIRONMENT_ID)
        .pipe(Effect.flip);

      expect(error).toMatchObject({ reason: "configuration" });
      expect(host.calls).toEqual(["ensure", "descriptor"]);
    }),
  );

  it.effect("does not consume the credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const host = makeSshHost({ failDescriptor: true });

      yield* makeDesktopSshEnvironmentGateway(() => host.bridge)
        .provision(TARGET)
        .pipe(Effect.flip);

      expect(host.calls).toEqual(["ensure", "descriptor"]);
    }),
  );

  it.effect("reconnects with the bearer from the last pairing", () =>
    Effect.gen(function* () {
      const host = makeSshHost();
      const gateway = makeDesktopSshEnvironmentGateway(() => host.bridge);
      const provisioned = yield* gateway.provision(TARGET);
      host.calls.length = 0;

      const prepared = yield* gateway.prepare(PREPARE_INPUT);

      expect(prepared.bearerToken).toBe(provisioned.bearerToken);
      expect(host.calls).toEqual(["tunnel", "descriptor", "session"]);
    }),
  );

  it.effect("pairs again when the server no longer honors the bearer", () =>
    Effect.gen(function* () {
      const host = makeSshHost({ authenticated: false });
      const gateway = makeDesktopSshEnvironmentGateway(() => host.bridge);
      yield* gateway.prepare(PREPARE_INPUT);
      host.calls.length = 0;

      yield* gateway.prepare(PREPARE_INPUT);

      expect(host.calls).toEqual([
        "tunnel",
        "descriptor",
        "session",
        "ensure",
        "descriptor",
        "token",
      ]);
    }),
  );

  it.effect("does not present the bearer to a different machine", () =>
    Effect.gen(function* () {
      let environmentId = ENVIRONMENT_ID;
      const host = makeSshHost({ environmentId: () => environmentId });
      const gateway = makeDesktopSshEnvironmentGateway(() => host.bridge);
      yield* gateway.provision(TARGET);
      environmentId = OTHER_ENVIRONMENT_ID;
      host.calls.length = 0;

      const error = yield* gateway.prepare(PREPARE_INPUT).pipe(Effect.flip);

      expect(error).toMatchObject({ reason: "configuration" });
      expect(host.calls).toEqual(["tunnel", "descriptor", "ensure", "descriptor"]);
    }),
  );

  it.effect("keeps no bearer from a machine the route did not expect", () =>
    Effect.gen(function* () {
      let environmentId = OTHER_ENVIRONMENT_ID;
      const host = makeSshHost({ environmentId: () => environmentId });
      const gateway = makeDesktopSshEnvironmentGateway(() => host.bridge);
      const error = yield* gateway.prepare(PREPARE_INPUT).pipe(Effect.flip);
      expect(error).toMatchObject({ reason: "configuration" });
      expect(host.calls).toEqual(["ensure", "descriptor"]);
      environmentId = ENVIRONMENT_ID;
      host.calls.length = 0;

      const prepared = yield* gateway.prepare(PREPARE_INPUT);

      expect(prepared.bearerToken).toBe(bearerFor(ENVIRONMENT_ID));
      expect(host.calls).toEqual(["ensure", "descriptor", "token"]);
    }),
  );

  it.effect("hands a timed-out attempt's setup to the next attempt", () =>
    Effect.gen(function* () {
      const setupDone = deferred();
      const host = makeSshHost({ setupDone: () => setupDone.promise });
      const gateway = makeDesktopSshEnvironmentGateway(() => host.bridge);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const timedOut = yield* Effect.forkChild(gateway.prepare(PREPARE_INPUT), FORK_NOW);
        yield* Fiber.interrupt(timedOut);
      }

      const next = yield* Effect.forkChild(gateway.prepare(PREPARE_INPUT), FORK_NOW);
      setupDone.resolve();
      const prepared = yield* Fiber.join(next);

      expect(prepared.bearerToken).toBe(bearerFor(ENVIRONMENT_ID));
      expect(host.calls).toEqual(["ensure", "descriptor", "token"]);
    }),
  );

  it.effect.each(["failed", "succeeded"] as const)(
    "starts its own setup once the abandoned one %s",
    (outcome) =>
      Effect.gen(function* () {
        const setupDone = deferred();
        const host = makeSshHost({
          setupDone: (call) => (call === 0 ? setupDone.promise : Promise.resolve()),
        });
        const gateway = makeDesktopSshEnvironmentGateway(() => host.bridge);
        const timedOut = yield* Effect.forkChild(gateway.prepare(PREPARE_INPUT), FORK_NOW);
        yield* Fiber.interrupt(timedOut);
        if (outcome === "failed") {
          setupDone.reject(new Error("remote launch failed"));
        } else {
          setupDone.resolve();
        }
        // The gateway subscribed first, so it has already let the setup go.
        yield* Effect.promise(() =>
          host.setups[0]!.then(
            () => undefined,
            () => undefined,
          ),
        );

        yield* gateway.prepare(PREPARE_INPUT);

        expect(host.calls).toEqual(["ensure", "ensure", "descriptor", "token"]);
      }),
  );
});

describe("desktop-local bearer cache", () => {
  const registration = {} as never;

  it("refreshes a secondary bearer before it expires", () => {
    const issuedAtEpochMs = 10_000;
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(issuedAtEpochMs, 60);
    const expiresAtEpochMs = secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, 60);
    const cached = {
      expiresAtEpochMs,
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(65_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 64_999)).toBe(true);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 65_000)).toBe(false);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 69_999),
    ).toBe(true);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 70_000),
    ).toBe(false);
  });

  it("does not cache credentials whose lifetime is shorter than the refresh skew", () => {
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(10_000, 3);
    const cached = {
      expiresAtEpochMs: secondaryBearerExpiresAtEpochMs(10_000, 3),
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(10_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 10_000)).toBe(false);
  });

  it("retains only unexpired secondaries after a topology read failure", () => {
    const valid = {
      expiresAtEpochMs: 20_000,
      signature: "valid-secondary",
      registration,
      refreshAtEpochMs: 15_000,
    };
    const previous = new Map([
      ["valid-secondary", valid],
      [
        "expired-secondary",
        {
          expiresAtEpochMs: 10_000,
          signature: "expired-secondary",
          registration,
          refreshAtEpochMs: 5_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Failure", cause: new Error("IPC unavailable") },
        10_000,
      ),
    ).toEqual(new Map([["valid-secondary", valid]]));
  });

  it("treats a successful empty topology as authoritative removal", () => {
    const previous = new Map([
      [
        "secondary",
        {
          expiresAtEpochMs: 20_000,
          signature: "secondary",
          registration,
          refreshAtEpochMs: 15_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Success", bootstraps: [] },
        10_000,
      ),
    ).toEqual(new Map());
  });
});

describe("rejected desktop-local bootstrap tokens", () => {
  it("backs off on a rejected signature and retries it on a growing, capped delay", () => {
    const signature = "http://a|ws://a|old-token";
    const first = nextRejectedSecondaryBootstrap(undefined, signature, 0);

    expect(isRejectedSecondaryBootstrap(first, signature, 59_999)).toBe(true);
    // A backend restarted on the same port accepts the same token again, so it is retried.
    expect(isRejectedSecondaryBootstrap(first, signature, 60_000)).toBe(false);

    const second = nextRejectedSecondaryBootstrap(first, signature, 60_000);
    expect(second.retryAtEpochMs).toBe(180_000);

    let backoff = second;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      backoff = nextRejectedSecondaryBootstrap(backoff, signature, 0);
    }
    expect(backoff.delayMs).toBe(30 * 60_000);
  });

  it("retries at once when the token or endpoint changes", () => {
    const rejected = nextRejectedSecondaryBootstrap(undefined, "http://a|ws://a|old-token", 0);

    expect(isRejectedSecondaryBootstrap(rejected, "http://a|ws://a|new-token", 1)).toBe(false);
    expect(isRejectedSecondaryBootstrap(rejected, "http://b|ws://b|old-token", 1)).toBe(false);
    expect(isRejectedSecondaryBootstrap(undefined, "http://a|ws://a|old-token", 1)).toBe(false);
    expect(nextRejectedSecondaryBootstrap(rejected, "http://a|ws://a|new-token", 1).delayMs).toBe(
      60_000,
    );
  });

  it("treats only authentication rejections as a dead credential", () => {
    expect(
      isRejectedBootstrapCredentialError(
        new ConnectionBlockedError({ reason: "authentication", detail: "invalid" }),
      ),
    ).toBe(true);
    expect(
      isRejectedBootstrapCredentialError(
        new ConnectionTransientError({ reason: "endpoint-unavailable", detail: "booting" }),
      ),
    ).toBe(false);
  });
});

describe("desktop-local bearer cache across token changes", () => {
  it("keeps a live bearer when only the bootstrap token rotates", () => {
    // Cached by endpoint: a rotated token reuses the bearer instead of
    // dropping the environment (and its drafts) when the new token is rejected.
    const cached = {
      signature: "http://a|ws://a",
      registration: {} as never,
      expiresAtEpochMs: 20_000,
      refreshAtEpochMs: 15_000,
    };

    expect(canReuseCachedPlatformRegistration(cached, "http://a|ws://a", 10_000)).toBe(true);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, "http://a|ws://a", 16_000),
    ).toBe(true);
    expect(canReuseCachedPlatformRegistration(cached, "http://b|ws://b", 10_000)).toBe(false);
  });
});

describe("primary topology cache", () => {
  const registration = {} as never;
  const cached = {
    signature: "primary|http://127.0.0.1:3773/|ws://127.0.0.1:3773/",
    registration,
  };
  const previous = new Map([[PRIMARY_LOCAL_ENVIRONMENT_ID, cached]]);

  it("captures synchronous primary target read failures", () => {
    const cause = new Error("invalid primary target");

    expect(
      readPrimaryEnvironmentTargetResult(() => {
        throw cause;
      }),
    ).toEqual({ _tag: "Failure", cause });
  });

  it("retains the cached primary after a transient topology read failure", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Failure",
        cause: new Error("IPC unavailable"),
      }),
    ).toBe(cached);
  });

  it("treats a successful primary absence as authoritative removal", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Success",
        target: null,
      }),
    ).toBeUndefined();
  });
});
