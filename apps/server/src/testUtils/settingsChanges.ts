import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as Settings from "../serverSettings.ts";

export const makeSettingsChanges = Effect.gen(function* () {
  let current = DEFAULT_SERVER_SETTINGS;
  let subscribers = 0;
  const changes = yield* PubSub.unbounded<{
    settings: ServerSettings;
    acknowledge: Effect.Effect<void>;
  }>();
  const service = {
    ...(yield* Settings.ServerSettingsService.pipe(Effect.provide(Settings.layerTest()))),
    getSettings: Effect.sync(() => current),
    subscribeChanges: Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      subscribers++;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          subscribers--;
        }),
      );
      return Stream.fromSubscription(subscription).pipe(
        Stream.flatMap(({ settings, acknowledge }) =>
          Stream.concat(Stream.make(settings), Stream.fromEffectDrain(acknowledge)),
        ),
      );
    }),
  };
  const publish = (settings: ServerSettings) =>
    Effect.gen(function* () {
      current = settings;
      let remaining = subscribers;
      const handled = yield* Deferred.make<void>();
      yield* PubSub.publish(changes, {
        settings,
        acknowledge: Effect.suspend(() =>
          --remaining === 0
            ? Deferred.succeed(handled, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
      });
      if (subscribers > 0) yield* Deferred.await(handled);
    });
  return { service, publish, subscribers: () => subscribers };
});
