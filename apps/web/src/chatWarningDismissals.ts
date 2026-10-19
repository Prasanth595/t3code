import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import type { ChatWarning } from "./components/chat/ChatWarningIndicator";
import { useLocalStorage } from "./hooks/useLocalStorage";
import { useStableCallback } from "./hooks/useStableCallback";

const STORAGE_KEY = "t3code:chat-warning-dismissals:v3";
const ChatWarningDismissals = Schema.Struct({
  temporary: Schema.Array(Schema.String),
  permanent: Schema.Array(Schema.String),
  lastKnownRunByEnvironment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const EMPTY_DISMISSALS: typeof ChatWarningDismissals.Type = {
  temporary: [],
  permanent: [],
};

export function useChatWarningDismissals() {
  return useLocalStorage(STORAGE_KEY, EMPTY_DISMISSALS, ChatWarningDismissals);
}

export function useChatWarnings(
  warnings: ReadonlyArray<ChatWarning | null>,
  environmentId: EnvironmentId,
  serverRunId: string | null,
) {
  const [dismissals, setDismissals] = useChatWarningDismissals();
  const setDismissalsStable = useStableCallback(setDismissals);
  const lastKnownRun = dismissals.lastKnownRunByEnvironment?.[environmentId] ?? null;
  useEffect(() => {
    if (serverRunId === null || serverRunId === lastKnownRun) return;
    setDismissalsStable((current) => ({
      ...current,
      lastKnownRunByEnvironment: {
        ...current.lastKnownRunByEnvironment,
        [environmentId]: serverRunId,
      },
    }));
  }, [environmentId, lastKnownRun, serverRunId, setDismissalsStable]);
  // Keep exact dismissals hidden on reload until ready confirms or replaces the previous run.
  const filteringRunId = serverRunId ?? lastKnownRun;
  const runPrefix =
    filteringRunId === null ? null : `${environmentId}\u0000${filteringRunId}\u0000`;
  const temporary = new Set(dismissals.temporary);
  const permanent = new Set(dismissals.permanent);
  return {
    warnings: warnings.filter(
      (warning): warning is ChatWarning =>
        warning !== null &&
        !permanent.has(warning.id) &&
        (runPrefix === null || !temporary.has(`${runPrefix}${warning.id}`)),
    ),
    dismissForNow: (ids: ReadonlyArray<string>) => {
      if (serverRunId === null || runPrefix === null) return;
      const environmentPrefix = `${environmentId}\u0000`;
      setDismissals((current) => ({
        ...current,
        temporary: [
          ...new Set([
            ...current.temporary.filter(
              (id) => !id.startsWith(environmentPrefix) || id.startsWith(runPrefix),
            ),
            ...ids.map((id) => `${runPrefix}${id}`),
          ]),
        ],
      }));
    },
    dismissForever: (ids: ReadonlyArray<string>) =>
      setDismissals((current) => ({
        ...current,
        permanent: [...new Set([...current.permanent, ...ids])],
      })),
  };
}
