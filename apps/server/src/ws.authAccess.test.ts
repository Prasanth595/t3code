import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthAccessStreamEvent,
  AuthAccessStreamError,
  AuthAdministrativeScopes,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import { RPC_REQUIRED_SCOPES } from "./auth/RpcAuthorization.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { rpcInitialItems } from "./rpcInitialItems.ts";
import { WS_RPC_SERVER_OPTIONS } from "./ws.ts";

const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.subscribeAuthAccess> =>
      tag !== WS_METHODS.subscribeAuthAccess,
  ),
);

const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-access-stream-test-" }),
  ),
);

const makeProtocol = Effect.gen(function* () {
  const responses = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
  const receive = yield* Deferred.make<Parameters<RpcServer.Protocol["Service"]["run"]>[0]>();
  const protocol = yield* RpcServer.Protocol.make((write) =>
    Effect.gen(function* () {
      yield* Deferred.succeed(receive, write);
      const serialization = yield* RpcSerialization.RpcSerialization;
      return {
        disconnects: yield* Queue.unbounded<number>(),
        send: (_clientId, response) => Queue.offer(responses, response),
        end: () => Effect.void,
        clientIds: Effect.succeed(new Set([0])),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: false,
        supportsNotifications: true,
        codecFor: serialization.codecFor,
      };
    }),
  );
  return { responses, receive, protocol };
});

const startRpc = Effect.fn(function* <R>(
  stream: Stream.Stream<AuthAccessStreamEvent, AuthAccessStreamError, R>,
  { responses, receive, protocol }: Effect.Success<typeof makeProtocol>,
) {
  yield* RpcServer.make(group, WS_RPC_SERVER_OPTIONS).pipe(
    Effect.provide(
      Layer.mergeAll(
        group.toLayerHandler(WS_METHODS.subscribeAuthAccess, () => stream),
        RpcAuthorization.layer(AuthAdministrativeScopes),
      ),
    ),
    Effect.provideService(RpcServer.Protocol, protocol),
    Effect.forkScoped,
  );
  return { write: yield* Deferred.await(receive), responses };
});

const decodeEvents = Schema.decodeUnknownSync(
  Schema.toCodecJson(Schema.Array(AuthAccessStreamEvent)),
);
const takeEvents = (responses: Queue.Queue<RpcMessage.FromServerEncoded>) =>
  Queue.take(responses).pipe(
    Effect.map((response) => {
      assert.equal(response._tag, "Chunk");
      return response._tag === "Chunk" ? decodeEvents(response.values) : [];
    }),
  );

it.layer(NodeServices.layer)("subscribeAuthAccess snapshot handoff", (it) => {
  it.effect.each([
    { change: "revoke link", milestone: "snapshot read" },
    { change: "revoke link", milestone: "snapshot ACK" },
    { change: "connect client", milestone: "snapshot read" },
    { change: "connect client", milestone: "snapshot ACK" },
    { change: "disconnect client", milestone: "snapshot read" },
    { change: "disconnect client", milestone: "snapshot ACK" },
  ] as const)("buffers $change while waiting for $milestone", ({ change, milestone }) =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const current = yield* sessions.issue({ subject: "current-client" });
      const link = yield* auth.createPairingLink({ label: "Revoked during subscription" });
      if (change === "disconnect client") yield* sessions.markConnected(current.sessionId);

      const snapshotRead = yield* Deferred.make<void>();
      const releaseSnapshot = yield* Deferred.make<void>();
      const { responses, receive, protocol } = yield* makeProtocol;
      const snapshotAuth = yield* EnvironmentAuth.make.pipe(
        Effect.provideService(SessionStore.SessionStore, {
          ...sessions,
          listActive: () =>
            sessions.listActive().pipe(
              Effect.tap(() => Deferred.succeed(snapshotRead, undefined)),
              Effect.flatMap((snapshot) =>
                Deferred.await(releaseSnapshot).pipe(Effect.as(snapshot)),
              ),
            ),
        }),
      );
      const { write } = yield* startRpc(
        Stream.unwrap(
          snapshotAuth.streamAccess(current.sessionId).pipe(
            Effect.map(({ snapshot, changes }) =>
              Stream.concat(rpcInitialItems([snapshot]), changes),
            ),
            Effect.mapError((error) => new AuthAccessStreamError({ message: error.message })),
          ),
        ),
        { responses, receive, protocol },
      );
      yield* write(0, {
        _tag: "Request",
        id: "1",
        tag: WS_METHODS.subscribeAuthAccess,
        payload: {},
        headers: [],
      });
      yield* Deferred.await(snapshotRead).pipe(
        Effect.raceFirst(
          Queue.take(responses).pipe(Effect.flatMap((response) => Effect.die(response))),
        ),
      );
      const mutate =
        change === "revoke link"
          ? auth.revokePairingLink(link.id)
          : change === "connect client"
            ? sessions.markConnected(current.sessionId)
            : sessions.markDisconnected(current.sessionId);
      if (milestone === "snapshot read") yield* mutate;
      yield* Deferred.succeed(releaseSnapshot, undefined);
      const [snapshot] = yield* takeEvents(responses);
      assert.equal(snapshot?.type, "snapshot");
      if (snapshot?.type !== "snapshot") return;
      assert.equal(snapshot.revision, 1);
      assert.deepEqual(
        snapshot.payload.pairingLinks.map((value) => value.id),
        [link.id],
      );
      assert.equal(snapshot.payload.clientSessions[0]?.connected, change === "disconnect client");
      if (milestone === "snapshot ACK") yield* mutate;
      yield* write(0, { _tag: "Ack", requestId: "1" });
      // Drain runnable fibers to attach the old handler's live streams. This does
      // not advance time. An unrelated update makes lost changes fail without a timeout.
      yield* TestClock.adjust(0);
      const unrelated = yield* auth.createPairingLink({ label: "Unrelated update" });
      const [next] = yield* takeEvents(responses);
      assert.equal(next?.revision, 2);
      if (change === "revoke link") {
        assert.equal(next?.type, "pairingLinkRemoved");
        if (next?.type === "pairingLinkRemoved") {
          assert.equal(next.payload.id, link.id);
          const remaining = snapshot.payload.pairingLinks.filter(
            (value) => value.id !== next.payload.id,
          );
          assert.deepEqual(
            remaining.map((value) => value.id),
            [],
          );
        }
      } else {
        assert.equal(next?.type, "clientUpserted");
        if (next?.type === "clientUpserted") {
          assert.equal(next.payload.sessionId, current.sessionId);
          assert.isTrue(next.payload.current);
          assert.equal(next.payload.connected, change === "connect client");
          assert.deepEqual(next.payload, (yield* auth.listClientSessions(current.sessionId))[0]);
        }
      }
      yield* write(0, { _tag: "Ack", requestId: "1" });
      const [following] = yield* takeEvents(responses);
      assert.equal(following?.revision, 3);
      assert.equal(following?.type, "pairingLinkUpserted");
      if (following?.type === "pairingLinkUpserted") {
        assert.equal(following.payload.id, unrelated.id);
        const remaining = snapshot.payload.pairingLinks.filter(
          (value) => change !== "revoke link" || value.id !== link.id,
        );
        assert.deepEqual(
          [...remaining, following.payload].map((value) => value.id).toSorted(),
          (yield* auth.listPairingLinks()).map((value) => value.id).toSorted(),
        );
      }
      yield* write(0, { _tag: "Interrupt", requestId: "1" });
      assert.equal((yield* Queue.take(responses))._tag, "Exit");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerAuth, RpcSerialization.layerJson))),
  );

  it.effect.each(["snapshot read", "snapshot ACK", "live tail", "snapshot failure"] as const)(
    "releases both subscriptions on cancellation or failure during %s",
    (milestone) =>
      Effect.gen(function* () {
        const pairingLinks = yield* PairingGrantStore.PairingGrantStore;
        const sessions = yield* SessionStore.SessionStore;
        const current = yield* sessions.issue({ subject: "current-client" });
        const acquired = yield* Queue.unbounded<PubSub.Subscription<unknown>>();
        const snapshotRead = yield* Deferred.make<void>();
        const releaseSnapshot = yield* Deferred.make<void>();
        const snapshotAuth = yield* EnvironmentAuth.make.pipe(
          Effect.provideService(PairingGrantStore.PairingGrantStore, {
            ...pairingLinks,
            subscribeChanges: pairingLinks.subscribeChanges.pipe(
              Effect.tap((subscription) => Queue.offer(acquired, subscription)),
            ),
          }),
          Effect.provideService(SessionStore.SessionStore, {
            ...sessions,
            subscribeChanges: sessions.subscribeChanges.pipe(
              Effect.tap((subscription) => Queue.offer(acquired, subscription)),
            ),
            listActive: () =>
              sessions.listActive().pipe(
                Effect.tap(() => Deferred.succeed(snapshotRead, undefined)),
                Effect.flatMap((snapshot) =>
                  Deferred.await(releaseSnapshot).pipe(
                    Effect.andThen(
                      milestone === "snapshot failure"
                        ? Effect.fail(new SessionStore.ActiveSessionsListError({ cause: "test" }))
                        : Effect.succeed(snapshot),
                    ),
                  ),
                ),
              ),
          }),
        );
        const { responses, receive, protocol } = yield* makeProtocol;
        const { write } = yield* startRpc(
          Stream.unwrap(
            snapshotAuth.streamAccess(current.sessionId).pipe(
              Effect.map(({ snapshot, changes }) =>
                Stream.concat(rpcInitialItems([snapshot]), changes),
              ),
              Effect.mapError((error) => new AuthAccessStreamError({ message: error.message })),
            ),
          ),
          { responses, receive, protocol },
        );
        yield* write(0, {
          _tag: "Request",
          id: "1",
          tag: WS_METHODS.subscribeAuthAccess,
          payload: {},
          headers: [],
        });
        const linkSubscription = yield* Queue.take(acquired);
        const clientSubscription = yield* Queue.take(acquired);
        yield* Deferred.await(snapshotRead);
        assert.isFalse(linkSubscription.shutdownFlag.current);
        assert.isFalse(clientSubscription.shutdownFlag.current);
        if (milestone !== "snapshot read") {
          yield* Deferred.succeed(releaseSnapshot, undefined);
          if (milestone !== "snapshot failure") yield* takeEvents(responses);
        }
        if (milestone === "live tail") {
          yield* sessions.markConnected(current.sessionId);
          yield* write(0, { _tag: "Ack", requestId: "1" });
          const [event] = yield* takeEvents(responses);
          assert.equal(event?.type, "clientUpserted");
        }
        if (milestone !== "snapshot failure") {
          yield* write(0, { _tag: "Interrupt", requestId: "1" });
        }
        assert.equal((yield* Queue.take(responses))._tag, "Exit");
        assert.isTrue(linkSubscription.shutdownFlag.current);
        assert.isTrue(clientSubscription.shutdownFlag.current);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerAuth, RpcSerialization.layerJson))),
  );
});
