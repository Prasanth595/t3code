import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

/**
 * The suggested next prompt after a thread's latest run, or null while it loads, when there is
 * none, or when the request failed. Pass null ids to skip asking; the server caches per run.
 */
export function usePromptSuggestion(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly runId: RunId | null;
}): string | null {
  const { environmentId, threadId, runId } = input;
  const query = useEnvironmentQuery(
    threadId === null || runId === null
      ? null
      : orchestrationEnvironment.promptSuggestion({ environmentId, input: { threadId, runId } }),
  );
  return query.data?.suggestion ?? null;
}

export function isPromptSuggestionAcceptKey(key: string, event: KeyboardEvent): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return false;
  return (key === "Tab" && !event.shiftKey) || (key === "ArrowRight" && !event.shiftKey);
}
