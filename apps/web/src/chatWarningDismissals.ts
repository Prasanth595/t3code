import type {
  EnvironmentId,
  OrchestrationV2ProviderFailureClass,
  ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import {
  type ChatWarning,
  resolveProviderChatWarning,
  resolveThreadErrorChatWarning,
} from "./components/chat/ChatWarningIndicator";
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

export function useChatWarnings({
  threadKey,
  error,
  errorClass,
  providerStatus,
  environmentId,
  serverRunId,
}: {
  threadKey: string;
  error: string | null;
  errorClass: OrchestrationV2ProviderFailureClass | null;
  providerStatus: ServerProvider | null;
  environmentId: EnvironmentId;
  serverRunId: string | null;
}) {
  const [dismissals, setDismissals] = useChatWarningDismissals();
  const setDismissalsStable = useStableCallback(setDismissals);
  const threadWarning = resolveThreadErrorChatWarning(threadKey, error, errorClass);
  const providerWarning = resolveProviderChatWarning(environmentId, providerStatus);
  const lastKnownRun = dismissals.lastKnownRunByEnvironment?.[environmentId] ?? null;
  // Storage updates may come from a newer tab; only record this owner's ready changes.
  useEffect(() => {
    if (serverRunId === null) return;
    setDismissalsStable((current) => {
      if (current.lastKnownRunByEnvironment?.[environmentId] === serverRunId) return current;
      return {
        ...current,
        lastKnownRunByEnvironment: {
          ...current.lastKnownRunByEnvironment,
          [environmentId]: serverRunId,
        },
      };
    });
  }, [environmentId, serverRunId, setDismissalsStable]);
  // Keep exact dismissals hidden on reload until ready confirms or replaces the previous run.
  const filteringRunId = serverRunId ?? lastKnownRun;
  const runPrefix =
    filteringRunId === null ? null : `${environmentId}\u0000${filteringRunId}\u0000`;
  const temporary = new Set(dismissals.temporary);
  const permanent = new Set(dismissals.permanent);
  return {
    warnings: [threadWarning, providerWarning].filter(
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
