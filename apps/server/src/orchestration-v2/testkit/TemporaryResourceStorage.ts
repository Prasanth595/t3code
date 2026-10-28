import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as TemporaryThreadStorage from "../TemporaryThreadStorage.ts";

export const temporaryResourceStorage = Layer.mock(TemporaryThreadStorage.TemporaryThreadStorage)({
  isTemporary: () => Effect.succeed(true),
  isDiscarded: () => Effect.succeed(false),
});
