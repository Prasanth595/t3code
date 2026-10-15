import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The factory's root layer. server.ts merges it into the runtime; nothing else imports it. */
export const FactoryLayer = Layer.effectDiscard(Effect.logInfo("factory started"));
