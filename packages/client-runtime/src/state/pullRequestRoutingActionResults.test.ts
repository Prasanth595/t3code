import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EnvironmentAuthorizationError,
  AuthSourceControlWriteScope,
  ProjectId,
  SourceControlProviderKind,
  PullRequestOperationError,
  WS_METHODS,
  type ServerConfig,
  type PullRequestActionInput,
  type PullRequestActionResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { type ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { PullRequestRoutingPermissions } from "../connection/pullRequestRoutingPermissions.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  RpcPermissionGuard,
  type EnvironmentRpcInput,
  type EnvironmentRpcSuccess,
  type EnvironmentRpcFailure,
} from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createPullRequestRouter } from "./pullRequestRouting.ts";

const actionMethod = WS_METHODS.pullRequestsRunActionWithResult;
const input = {
  projectId: ProjectId.make("project-1"),
  host: "github.com",
  repository: "acme/web",
  number: 7,
  action: "merge",
  stackNumber: 7,
  expectedStackHeads: [{ number: 7, headSha: "head-1" }],
} satisfies PullRequestActionInput;
const result = {
  state: "open" as const,
  isDraft: false,
  updatedAt: "2026-10-27T00:00:00.000Z",
  mergedAt: null,
  closedAt: null,
  autoMergeEnabled: true,
  observedAt: 1,
} satisfies PullRequestActionResult;
const identity = {
  host: "github.com",
  provider: SourceControlProviderKind.make("github"),
  viewer: "test",
  accountId: "123",
} as const;

type TestClient = {
  [
    K in
      | typeof WS_METHODS.pullRequestsRouting
      | typeof WS_METHODS.pullRequestsRoutingIdentity
      | typeof WS_METHODS.serverGetConfig
      | typeof WS_METHODS.pullRequestsRunAction
      | typeof actionMethod
      | typeof WS_METHODS.pullRequestsInvalidate
      | typeof WS_METHODS.pullRequestsReportState
  ]: (
    input: EnvironmentRpcInput<K>,
  ) => Effect.Effect<EnvironmentRpcSuccess<K>, EnvironmentRpcFailure<K>>;
};

function client(results: boolean | undefined, calls: unknown[][], name: string): TestClient {
  return {
    [WS_METHODS.pullRequestsRouting]: () =>
      Effect.succeed({ ...identity, projectTitle: "Project", workspaceRoot: "/tmp/project" }),
    [WS_METHODS.pullRequestsRoutingIdentity]: () => Effect.succeed(identity),
    [WS_METHODS.serverGetConfig]: () =>
      Effect.succeed({
        environment: { capabilities: { pullRequestActionResults: results } },
      } as unknown as ServerConfig),
    [WS_METHODS.pullRequestsRunAction]: (value: unknown) =>
      Effect.sync(() => {
        calls.push([name, "old", value]);
      }),
    [actionMethod]: (value: unknown) =>
      Effect.sync(() => {
        calls.push([name, "new", value]);
        return result;
      }),
    [WS_METHODS.pullRequestsInvalidate]: (value: unknown) =>
      Effect.sync(() => {
        calls.push([name, "invalidate", value]);
      }),
    [WS_METHODS.pullRequestsReportState]: () => Effect.void,
  };
}

const makeRuntime = Effect.fn("makeRuntime")(function* (
  originClient: ReturnType<typeof client>,
  destinationClient?: ReturnType<typeof client>,
) {
  const supervisors = yield* Effect.forEach(
    [originClient, ...(destinationClient ? [destinationClient] : [])],
    (rpc, index) =>
      Effect.gen(function* () {
        const session: RpcSession = {
          client: rpc as unknown as WsRpcProtocolClient,
          initialConfig: rpc[WS_METHODS.serverGetConfig]({}).pipe(Effect.orDie),
          subscribeServerConfig: () => Stream.never,
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        };
        return EnvironmentSupervisor.of({
          target: new PrimaryConnectionTarget({
            environmentId: EnvironmentId.make(index === 0 ? "origin" : "destination"),
            label: String(index),
            httpBaseUrl: index === 0 ? "https://origin.test" : "http://localhost:3773",
            wsBaseUrl: index === 0 ? "wss://origin.test" : "ws://localhost:3773",
          }),
          session: yield* SubscriptionRef.make(Option.some(session)),
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
      }),
  );
  const origin = supervisors[0]!;
  const registry = EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map(
        supervisors.map((supervisor) => [
          supervisor.target.environmentId,
          { target: supervisor.target, profile: Option.none(), enabled: true },
        ]),
      ),
    ),
    run: (id, effect) =>
      effect.pipe(
        Effect.provideService(
          EnvironmentSupervisor,
          supervisors.find((supervisor) => supervisor.target.environmentId === id)!,
        ),
      ),
    runStream: (_id, stream) => stream.pipe(Stream.provideService(EnvironmentSupervisor, origin)),
    followStream: (_id, stream) =>
      stream.pipe(Stream.provideService(EnvironmentSupervisor, origin)),
  } as EnvironmentRegistry["Service"]);
  return {
    run: (
      permission = "read-write" as "read-write" | "off",
      guard: Context.Service.Shape<typeof RpcPermissionGuard> = { authorize: () => Effect.void },
    ) =>
      createPullRequestRouter()(actionMethod, input).pipe(
        Effect.provideService(EnvironmentRegistry, registry),
        Effect.provideService(EnvironmentSupervisor, origin),
        Effect.provideService(PullRequestRoutingPermissions, {
          get: () => Effect.succeed(permission),
          changes: Stream.empty,
          set: () => Effect.void,
          forget: () => Effect.void,
        }),
        Effect.provideService(RpcPermissionGuard, guard),
      ),
  };
});

it.effect.each([
  { origin: true, destination: true },
  { origin: true, destination: undefined },
  { origin: undefined, destination: true },
  { origin: undefined, destination: undefined },
  { origin: true, destination: false },
])("uses destination action capability for $origin to $destination", (capabilities) =>
  Effect.gen(function* () {
    const calls: unknown[][] = [];
    const runtime = yield* makeRuntime(
      client(capabilities.origin, calls, "origin"),
      client(capabilities.destination, calls, "destination"),
    );
    expect(yield* runtime.run()).toEqual(capabilities.destination ? result : null);
    expect(calls.filter((call) => call[1] !== "invalidate")).toEqual([
      [
        "destination",
        capabilities.destination ? "new" : "old",
        { ...input, expectedAccountId: "123" },
      ],
    ]);
    for (const environment of ["origin", "destination"]) {
      expect(calls).toContainEqual([environment, "invalidate", { reference: input }]);
      expect(calls).toContainEqual([environment, "invalidate", {}]);
    }
  }),
);

it.effect.each([{ missing: "origin" }, { missing: "destination" }])(
  "keeps writes on origin when $missing lacks account routing metadata",
  ({ missing }) =>
    Effect.gen(function* () {
      const calls: unknown[][] = [];
      const origin = client(undefined, calls, "origin");
      const destination = client(true, calls, "destination");
      if (missing === "origin")
        origin[WS_METHODS.pullRequestsRouting] = () => Effect.die("unknown method");
      else destination[WS_METHODS.pullRequestsRoutingIdentity] = () => Effect.die("unknown method");
      const runtime = yield* makeRuntime(origin, destination);
      expect(yield* runtime.run()).toBeNull();
      expect(calls.filter((call) => call[1] !== "invalidate")).toEqual([
        ["origin", "old", missing === "origin" ? input : { ...input, expectedAccountId: "123" }],
      ]);
    }),
);

it.effect.each([{ results: true }, { results: undefined }])(
  "denies writes without destination permission: $results",
  ({ results }) =>
    Effect.gen(function* () {
      const calls: unknown[][] = [];
      const runtime = yield* makeRuntime(
        client(true, calls, "origin"),
        client(results, calls, "destination"),
      );
      const failure = new EnvironmentAuthorizationError({
        message: "Denied",
        requiredScope: AuthSourceControlWriteScope,
      });
      const authorization = yield* runtime
        .run("read-write", {
          authorize: (environmentId) =>
            environmentId === "destination" ? Effect.fail(failure) : Effect.void,
        })
        .pipe(Effect.flip);
      expect(authorization).toEqual(failure);
      expect(calls).toEqual([]);
    }),
);

it.effect("returns a null action result without retrying the write", () =>
  Effect.gen(function* () {
    const calls: unknown[][] = [];
    const destination = client(true, calls, "destination");
    destination[actionMethod] = (value) =>
      Effect.sync(() => {
        calls.push(["destination", "new", value]);
        return null;
      });
    const runtime = yield* makeRuntime(client(true, calls, "origin"), destination);
    expect(yield* runtime.run()).toBeNull();
    expect(calls.filter((call) => call[1] !== "invalidate")).toEqual([
      ["destination", "new", { ...input, expectedAccountId: "123" }],
    ]);
  }),
);

it.effect.each([{ results: true }, { results: undefined }, { results: false }])(
  "uses source action capability without an alternate: $results",
  ({ results }) =>
    Effect.gen(function* () {
      const calls: unknown[][] = [];
      const runtime = yield* makeRuntime(client(results, calls, "origin"));
      expect(yield* runtime.run()).toEqual(results ? result : null);
      expect(calls).toEqual([["origin", results ? "new" : "old", input]]);
    }),
);

it.effect.each([{ mismatch: true }, { mismatch: false }])(
  "keeps action on origin when account mismatches or routing is off: $mismatch",
  ({ mismatch }) =>
    Effect.gen(function* () {
      const calls: unknown[][] = [];
      const destination = client(true, calls, "destination");
      destination[WS_METHODS.pullRequestsRoutingIdentity] = () =>
        Effect.succeed({ ...identity, accountId: "456" });
      const runtime = yield* makeRuntime(client(undefined, calls, "origin"), destination);
      expect(yield* runtime.run(mismatch ? "read-write" : "off")).toBeNull();
      expect(calls.filter((call) => call[1] !== "invalidate")).toEqual([
        ["origin", "old", mismatch ? { ...input, expectedAccountId: "123" } : input],
      ]);
    }),
);

it.effect.each([{ results: true }, { results: undefined }])(
  "does not retry an ambiguous destination mutation: $results",
  ({ results }) =>
    Effect.gen(function* () {
      const calls: unknown[][] = [];
      const destination = client(results, calls, "destination");
      const failure = new PullRequestOperationError({ operation: "runAction", detail: "lost" });
      const fail = (value: unknown) =>
        Effect.sync(() => calls.push(["destination", "failed", value])).pipe(
          Effect.andThen(Effect.fail(failure)),
        );
      destination[actionMethod] = fail;
      destination[WS_METHODS.pullRequestsRunAction] = fail;
      const runtime = yield* makeRuntime(client(true, calls, "origin"), destination);
      expect(yield* runtime.run().pipe(Effect.flip)).toEqual(failure);
      expect(calls).toEqual([["destination", "failed", { ...input, expectedAccountId: "123" }]]);
    }),
);
