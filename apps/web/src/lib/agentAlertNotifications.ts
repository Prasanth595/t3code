import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { subscribe } from "@t3tools/client-runtime/rpc";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { emitAgentAlert } from "./agentAlertPresenter";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (typeof window === "undefined") return;
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const running = yield* Ref.make(new Map<EnvironmentId, Fiber.Fiber<void, unknown>>());
    const sync = Effect.fnUntraced(function* (entries: ReadonlyMap<EnvironmentId, unknown>) {
      const current = yield* Ref.get(running);
      for (const [environmentId, fiber] of current) {
        if (entries.has(environmentId)) continue;
        yield* Fiber.interrupt(fiber);
        yield* Ref.update(running, (next) => {
          const updated = new Map(next);
          updated.delete(environmentId);
          return updated;
        });
      }
      for (const environmentId of entries.keys()) {
        if ((yield* Ref.get(running)).has(environmentId)) continue;
        const fiber = yield* registry
          .followStream(environmentId, subscribe(WS_METHODS.serverSubscribeAgentAlerts, {}))
          .pipe(
            Stream.runForEach((alert) =>
              Effect.sync(() =>
                emitAgentAlert({
                  environmentId,
                  threadId: alert.threadId,
                  body: alert.body,
                }),
              ),
            ),
            Effect.forkScoped,
          );
        yield* Ref.update(running, (next) => {
          const updated = new Map(next);
          updated.set(environmentId, fiber);
          return updated;
        });
      }
    });
    yield* Stream.concat(
      Stream.fromEffect(SubscriptionRef.get(registry.entries)),
      SubscriptionRef.changes(registry.entries),
    ).pipe(
      Stream.runForEach((entries) => sync(entries)),
      Effect.forkScoped,
    );
  }),
);
