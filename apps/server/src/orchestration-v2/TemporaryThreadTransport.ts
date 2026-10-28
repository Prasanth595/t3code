import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as TemporaryThreadStorage from "./TemporaryThreadStorage.ts";

export const getReadState = Effect.fn("TemporaryThreadTransport.getReadState")(function* (
  threadId: ThreadId,
  acceptTemporaryThreads?: boolean,
) {
  const storage = yield* Effect.serviceOption(TemporaryThreadStorage.TemporaryThreadStorage);
  if (Option.isNone(storage))
    return { allowed: true, temporary: false, discarded: false, generation: undefined };
  const temporary = yield* storage.value.isTemporary(threadId);
  const discarded = yield* storage.value.isDiscarded(threadId);
  return {
    allowed: !discarded && (!temporary || acceptTemporaryThreads === true),
    temporary,
    discarded,
    generation: yield* storage.value.generation(threadId),
  };
});
