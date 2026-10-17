import type { ServerProvider, ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as MuseUsage from "../nofun/MuseUsage.ts";

/** Reuse account-bound provider observations; never refresh or launch a model. */
export const makeProviderCapacityReader = Effect.gen(function* () {
  const muse = yield* Effect.serviceOption(MuseUsage.MuseUsage);
  return (providers: ReadonlyArray<ServerProvider>) =>
    Effect.gen(function* () {
      const sources = Option.isSome(muse) ? yield* muse.value.current : [];
      const observations = new Map<
        string,
        {
          limits: ServerProviderUsageLimits | undefined;
          source: "provider" | "muse" | "unavailable";
        }
      >();
      for (const provider of providers) {
        // Source ids contain the configured instance id, not its display label.
        // Never borrow a different instance/account just because drivers match.
        const museSource = sources.find(
          (source) => source.kind === "muse" && source.id === `muse:${provider.instanceId}`,
        );
        const museLimits = museSource?.accounts[0]?.usageLimits;
        const isMuse = String(provider.driver) === "muse" || museSource !== undefined;
        const limits = isMuse ? museLimits : provider.usageLimits;
        observations.set(provider.instanceId, {
          limits,
          source: limits === undefined ? "unavailable" : isMuse ? "muse" : "provider",
        });
      }
      return observations;
    });
});
