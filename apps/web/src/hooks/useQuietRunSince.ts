import { useAtomValue } from "@effect/atom-react";
import { quietRunId, quietRunSince } from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";

import { serverEnvironment } from "../state/server";

/** Selects one thread's entry, so a quiet-runs update re-renders only the rows it changes. */
export function useQuietRunSince(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  activeRunId: RunId | null | undefined,
): string | null {
  return useAtomValue(serverEnvironment.configValueAtom(environmentId), (config) =>
    threadId === null ? null : quietRunSince(config, threadId, activeRunId),
  );
}

/** The quiet run's id, for Stop and Force stop to target it and nothing newer. */
export function useQuietRunId(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  activeRunId: RunId | null | undefined,
): RunId | undefined {
  const runId = useAtomValue(serverEnvironment.configValueAtom(environmentId), (config) =>
    threadId === null ? null : quietRunId(config, threadId, activeRunId),
  );
  return runId ?? undefined;
}
