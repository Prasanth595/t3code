import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ChatWarning } from "./components/chat/ChatWarningIndicator";
import { useLocalStorage } from "./hooks/useLocalStorage";

const STORAGE_KEY = "t3code:chat-warning-dismissals:v3";
const ChatWarningDismissals = Schema.Struct({
  temporary: Schema.Array(Schema.String),
  permanent: Schema.Array(Schema.String),
});
const EMPTY_DISMISSALS = {
  temporary: [],
  permanent: [],
} satisfies typeof ChatWarningDismissals.Type;

export function useChatWarningDismissals() {
  return useLocalStorage(STORAGE_KEY, EMPTY_DISMISSALS, ChatWarningDismissals);
}

export function useChatWarnings(
  warnings: ReadonlyArray<ChatWarning | null>,
  environmentId: EnvironmentId,
  serverRunId: string | null,
) {
  const [dismissals, setDismissals] = useChatWarningDismissals();
  const runPrefix = serverRunId === null ? null : `${environmentId}\u0000${serverRunId}\u0000`;
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
      if (runPrefix === null) return;
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
