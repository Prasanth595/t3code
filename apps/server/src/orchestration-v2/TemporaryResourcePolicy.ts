import { ThreadId, TemporaryResourceError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as TemporaryThreadDiagnostics from "../observability/TemporaryThreadDiagnostics.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as TemporaryThreadStorage from "./TemporaryThreadStorage.ts";

export const make = Effect.gen(function* () {
  const storage = yield* Effect.serviceOption(TemporaryThreadStorage.TemporaryThreadStorage);
  const diagnostics = yield* Effect.serviceOption(
    TemporaryThreadDiagnostics.TemporaryThreadDiagnostics,
  );
  const canRecordUnattributed = () => Option.isNone(diagnostics) || diagnostics.value.canRecord();
  const assertUnattributedDurable = Effect.fn("TemporaryResourcePolicy.assertUnattributedDurable")(
    function* (resource: string) {
      if (Option.isSome(diagnostics) && diagnostics.value.hasTemporaryThreads())
        return yield* new TemporaryResourceError({ resource });
    },
  );
  const isVolatile = Effect.fn("TemporaryResourcePolicy.isVolatile")(function* (threadId: string) {
    if (Option.isNone(storage)) return false;
    const id = ThreadId.make(threadId);
    return (yield* storage.value.isTemporary(id)) || (yield* storage.value.isDiscarded(id));
  });
  const assertDurable = Effect.fn("TemporaryResourcePolicy.assertDurable")(function* (
    threadId: string,
    resource: string,
  ) {
    if (yield* isVolatile(threadId)) return yield* new TemporaryResourceError({ resource });
  });
  const assertCopyTarget = Effect.fn("TemporaryResourcePolicy.assertCopyTarget")(function* (
    source: string,
    target: string | undefined,
  ) {
    if (!(yield* isVolatile(source))) return;
    if (
      target !== undefined &&
      Option.isSome(storage) &&
      !(yield* storage.value.isDiscarded(ThreadId.make(source)))
    ) {
      const family = yield* storage.value.family(ThreadId.make(source));
      if (
        family.includes(ThreadId.make(target)) &&
        (yield* storage.value.isTemporary(ThreadId.make(target)))
      )
        return;
    }
    return yield* new TemporaryResourceError({ resource: "cross-thread actions" });
  });
  return {
    isVolatile,
    assertDurable,
    assertCopyTarget,
    assertUnattributedDurable,
    canRecordUnattributed,
  };
});

export const assertCurrentThreadDurable = Effect.fn(
  "TemporaryResourcePolicy.assertCurrentThreadDurable",
)(function* (resource: string) {
  const invocation = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
  const threadId = Option.isSome(invocation) ? invocation.value.thread?.threadId : undefined;
  if (threadId === undefined) return;
  const policy = yield* make;
  yield* policy.assertDurable(threadId, resource);
});
