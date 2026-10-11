import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: NetAddress.inetAddressFromIpStringUnsafe(hostname, port),
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect(
  "a suspended thread lease preserves unrelated issuance and same-thread revocation fencing",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(() => 1000);
      const threadId = ThreadId.make("leased-A");
      const request = { threadId, providerInstanceId: ProviderInstanceId.make("codex") };
      const issued = yield* registry.issue(request);
      const scope = yield* registry.resolve(
        issued.config.authorizationHeader.replace("Bearer ", ""),
      );
      if (scope === undefined) return yield* Effect.die("Missing A credential");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const leased = yield* registry
        .withCurrentCredential(
          scope,
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return "A committed";
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const revokeEntered = yield* Deferred.make<void>();
      const revokeCompleted = yield* Deferred.make<void>();
      const revoked = yield* Effect.gen(function* () {
        yield* Deferred.succeed(revokeEntered, undefined);
        yield* registry.revokeThread(threadId);
        yield* Deferred.succeed(revokeCompleted, undefined);
      }).pipe(Effect.forkChild);
      yield* Deferred.await(revokeEntered);
      const other = yield* registry.issue({ ...request, threadId: ThreadId.make("unrelated-B") });
      const b = yield* registry.resolve(other.config.authorizationHeader.replace("Bearer ", ""));
      expect(b?.thread.threadId).toBe("unrelated-B");
      expect(yield* registry.isCurrentCredential(scope)).toBe(true);
      expect(Option.isNone(yield* Deferred.poll(revokeCompleted))).toBe(true);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(leased)).toBe("A committed");
      yield* Fiber.join(revoked);
      expect(yield* registry.isCurrentCredential(scope)).toBe(false);
      const stale = yield* Effect.exit(
        registry.withCurrentCredential(scope, Effect.succeed("must refuse")),
      );
      expect(Exit.isFailure(stale)).toBe(true);
      expect(
        (yield* registry.resolve(other.config.authorizationHeader.replace("Bearer ", "")))?.thread
          .threadId,
      ).toBe("unrelated-B");
    }),
);

it.effect("same-thread replacement waits for the captured credential lease", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1000);
    const request = {
      threadId: ThreadId.make("replace-A"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    };
    const issued = yield* registry.issue(request);
    const scope = yield* registry.resolve(issued.config.authorizationHeader.replace("Bearer ", ""));
    if (scope === undefined) return yield* Effect.die("Missing credential");
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const leased = yield* registry
      .withCurrentCredential(
        scope,
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as("committed"),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const replacement = yield* registry.issue(request).pipe(Effect.forkChild);
    expect(yield* registry.isCurrentCredential(scope)).toBe(true);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(leased)).toBe("committed");
    const newer = yield* Fiber.join(replacement);
    expect(yield* registry.isCurrentCredential(scope)).toBe(false);
    expect(
      (yield* registry.resolve(newer.config.authorizationHeader.replace("Bearer ", "")))?.thread
        .providerSessionId,
    ).toBe(newer.config.providerSessionId);
  }),
);

it.effect(
  "scoped authority rejects replacement and expired credentials while generic resolution retains its policy",
  () =>
    Effect.gen(function* () {
      let timestamp = 1000;
      const registry = yield* makeRegistry(() => timestamp);
      const request = {
        threadId: ThreadId.make("scoped-authority"),
        providerInstanceId: ProviderInstanceId.make("codex"),
      };
      const first = yield* registry.issue(request);
      const token = first.config.authorizationHeader.replace("Bearer ", "");
      const scope = yield* registry.resolve(token);
      if (scope === undefined) return yield* Effect.die("Missing issued credential");
      expect(yield* registry.withCurrentCredential(scope, Effect.succeed("admitted"))).toBe(
        "admitted",
      );
      yield* registry.issue(request);
      expect(yield* registry.isCurrentCredential(scope)).toBe(false);
      expect((yield* registry.resolve(token))?.thread.providerSessionId).toBe(
        scope.thread.providerSessionId,
      );
      expect(
        Exit.isFailure(
          yield* Effect.exit(registry.withCurrentCredential(scope, Effect.succeed("must refuse"))),
        ),
      ).toBe(true);
      const current = yield* registry.issue({
        ...request,
        threadId: ThreadId.make("expiring-scoped"),
      });
      const currentScope = yield* registry.resolve(
        current.config.authorizationHeader.replace("Bearer ", ""),
      );
      if (currentScope === undefined) return yield* Effect.die("Missing current credential");
      expect(yield* registry.isCurrentCredential(currentScope)).toBe(true);
      timestamp += 101;
      expect(yield* registry.isCurrentCredential(currentScope)).toBe(false);
    }),
);

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.thread.threadId).toBe(threadId);
    expect(resolved?.capabilities).toEqual(
      new Set(["preview", "orchestration", "worktree", "pull-requests"]),
    );

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("always grants pull-requests and gates browser and device access independently", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const withPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const withoutPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-no-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(),
    });
    const withDevice = yield* registry.issue({
      threadId: ThreadId.make("thread-device"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["device"]),
    });
    const capabilitiesOf = (issued: typeof withPreview) =>
      registry
        .resolve(issued.config.authorizationHeader.replace(/^Bearer\s+/, ""))
        .pipe(Effect.map((scope) => [...(scope?.capabilities ?? [])].sort()));

    expect(yield* capabilitiesOf(withPreview)).toEqual([
      "orchestration",
      "preview",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* capabilitiesOf(withoutPreview)).toEqual([
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* capabilitiesOf(withDevice)).toEqual([
      "device",
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["::", "http://127.0.0.1:43123/mcp"],
      ["::1", "http://[::1]:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("keeps a credential alive across turns that never touch an MCP tool", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-3");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    // Well past the liveness window in total, but each turn reports in before
    // it lapses — this is the long-session case that used to lose the toolkit.
    for (let turn = 0; turn < 10; turn += 1) {
      timestamp += 99;
      yield* registry.touch(threadId);
    }

    expect((yield* registry.resolve(token))?.thread.threadId).toBe(threadId);
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);
