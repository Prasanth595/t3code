import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthAccessReadScope, AuthOrchestrationReadScope, EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { FORK_SESSION_IDLE_LIMIT } from "./forkSessions.ts";

// The cleanup runs in a fiber of the store layer, so the layer itself needs the test clock.
const layerSessionStore = SessionStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("fork-sessions-test")),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-sessions-test-" })),
  Layer.provideMerge(TestClock.layer()),
);

const machineSession = {
  subject: "machine:mac",
  method: "bearer-access-token",
  client: { label: "machine Mac", deviceType: "bot" },
} as const;

it.layer(NodeServices.layer)("fork sessions", (it) => {
  it.effect("gives a machine its live session again and rotates it on a scope change", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const first = yield* sessions.issue({ ...machineSession, scopes: [AuthAccessReadScope] });
      const again = yield* sessions.issue({ ...machineSession, scopes: [AuthAccessReadScope] });
      expect(again.sessionId).toBe(first.sessionId);
      // The same token: a change of the upstream claims format breaks this before it ships.
      expect(again.token).toBe(first.token);

      const rotated = yield* sessions.issue({
        ...machineSession,
        scopes: [AuthAccessReadScope, AuthOrchestrationReadScope],
      });
      expect(rotated.sessionId).not.toBe(first.sessionId);
      const active = yield* sessions.listActive();
      expect(active.map((session) => session.sessionId)).toEqual([rotated.sessionId]);
    }).pipe(Effect.scoped, Effect.provide(layerSessionStore)),
  );

  it.effect("gives two requests at once one session", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const request = sessions.issue({ ...machineSession, scopes: [AuthAccessReadScope] });
      const [left, right] = yield* Effect.all([request, request], { concurrency: "unbounded" });
      expect(left.sessionId).toBe(right.sessionId);
      expect(yield* sessions.listActive()).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layerSessionStore)),
  );

  it.effect("ends idle fork sessions and keeps upstream ones", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const machine = yield* sessions.issue({ ...machineSession, scopes: [AuthAccessReadScope] });
      const pairingLink = yield* sessions.issue({
        subject: "one-time-token",
        method: "bearer-access-token",
        scopes: [AuthAccessReadScope],
      });

      yield* TestClock.adjust(Duration.subtract(FORK_SESSION_IDLE_LIMIT, Duration.hours(2)));
      expect((yield* sessions.listActive()).map((session) => session.sessionId)).toContain(
        machine.sessionId,
      );

      yield* TestClock.adjust(Duration.hours(3));
      expect((yield* sessions.listActive()).map((session) => session.sessionId)).toEqual([
        pairingLink.sessionId,
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerSessionStore)),
  );
});
