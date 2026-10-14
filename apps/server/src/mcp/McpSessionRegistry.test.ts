import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";

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

const authenticatedScope = (registry: McpSessionRegistry.McpSessionRegistryShape) =>
  Effect.gen(function* () {
    const issued = yield* registry.issue({
      threadId: ThreadId.make("authority-thread"),
      providerInstanceId: ProviderInstanceId.make("custom-codex-instance"),
    });
    const scope = yield* registry.resolve(
      issued.config.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    if (scope === undefined) return yield* Effect.die("Test credential was not resolved.");
    return { issued, scope };
  });

it.effect("queries existing scope liveness without renewing its expiry", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const { scope } = yield* authenticatedScope(registry);
    timestamp = 1_100;
    expect(yield* registry.isActiveScope!(scope)).toBe(true);
    timestamp = 1_101;
    expect(yield* registry.isActiveScope!(scope)).toBe(false);
    yield* registry.touch(scope.thread.threadId);
    expect(yield* registry.isActiveScope!(scope)).toBe(false);
  }),
);

it.effect("rejects changes to every part of the authenticated scope identity", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const { scope } = yield* authenticatedScope(registry);
    const altered: ReadonlyArray<McpInvocationContext.McpThreadInvocationScope> = [
      { ...scope, environmentId: EnvironmentId.make("other-env") },
      { ...scope, requestNamespace: "other-namespace" },
      { ...scope, issuedAt: scope.issuedAt + 1 },
      { ...scope, thread: { ...scope.thread, threadId: ThreadId.make("other-thread") } },
      { ...scope, thread: { ...scope.thread, providerSessionId: "other-session" } },
      {
        ...scope,
        thread: { ...scope.thread, providerInstanceId: ProviderInstanceId.make("other-instance") },
      },
      { ...scope, capabilities: new Set(["orchestration"]) },
      { ...scope, capabilities: new Set([...scope.capabilities, "device"]) },
      {
        ...scope,
        client: { sessionId: "client", label: "client", runtimeModeCeiling: "full-access" },
      },
    ];
    for (const candidate of altered) expect(yield* registry.isActiveScope!(candidate)).toBe(false);
    expect(
      yield* registry.isActiveScope!({
        ...scope,
        capabilities: new Set([...scope.capabilities].toReversed()),
      }),
    ).toBe(true);
  }),
);

it.effect("rejects revoked and replaced sessions even on the same thread", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const first = yield* authenticatedScope(registry);
    yield* registry.revokeProviderSession(first.scope.thread.providerSessionId);
    const second = yield* authenticatedScope(registry);
    expect(yield* registry.isActiveScope!(first.scope)).toBe(false);
    expect(yield* registry.isActiveScope!(second.scope)).toBe(true);
    yield* registry.revokeThread(second.scope.thread.threadId);
    expect(yield* registry.isActiveScope!(second.scope)).toBe(false);
    const third = yield* authenticatedScope(registry);
    yield* registry.revokeAll;
    expect(yield* registry.isActiveScope!(third.scope)).toBe(false);
  }),
);

it.effect("keeps issued and resolved objects from rewriting private registry identity", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const { issued, scope } = yield* authenticatedScope(registry);
    const original = {
      ...scope,
      thread: { ...scope.thread },
      capabilities: new Set(scope.capabilities),
    };
    (issued.config.capabilities as Set<McpInvocationContext.McpCapability>).add("device");
    (scope.capabilities as Set<McpInvocationContext.McpCapability>).clear();
    const changed = {
      ...original,
      thread: { ...original.thread, providerSessionId: "forged-session" },
    };
    expect(yield* registry.isActiveScope!(changed)).toBe(false);
    expect(yield* registry.isActiveScope!(scope)).toBe(false);
    expect(yield* registry.isActiveScope!(original)).toBe(true);
    const fresh = yield* registry.resolve(
      issued.config.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    expect(fresh?.capabilities).toEqual(original.capabilities);
  }),
);
