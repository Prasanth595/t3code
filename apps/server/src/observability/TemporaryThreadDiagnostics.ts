import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as LogLevel from "effect/LogLevel";

export const operationalLogMessages: ReadonlyMap<LogLevel.LogLevel, string> = new Map([
  ["Warn", "Server warning"],
  ["Error", "Server error"],
  ["Fatal", "Server fatal error"],
]);

export class TemporaryThreadDiagnostics extends Context.Service<
  TemporaryThreadDiagnostics,
  {
    readonly enter: (threadId: ThreadId) => void;
    readonly leave: (threadId: ThreadId, kept?: boolean) => void;
    readonly canRecord: () => boolean;
    readonly canRecordOperational: () => boolean;
    readonly hasTemporaryThreads: () => boolean;
    readonly canSnapshot: () => boolean;
  }
>()("t3/observability/TemporaryThreadDiagnostics") {}

export const layer = Layer.sync(TemporaryThreadDiagnostics, () => {
  const active = new Set<ThreadId>();
  let discarded = false;
  const canRecord = () => active.size === 0 && !discarded;
  return TemporaryThreadDiagnostics.of({
    enter: (threadId) => {
      active.add(threadId);
    },
    leave: (threadId, kept = false) => {
      if (active.delete(threadId) && !kept) discarded = true;
    },
    canRecord,
    canRecordOperational: () => active.size === 0,
    hasTemporaryThreads: () => active.size > 0,
    canSnapshot: canRecord,
  });
});
