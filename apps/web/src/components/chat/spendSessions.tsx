import type { EnvironmentId, ThreadId, UsageSessionRef } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import * as Option from "effect/Option";
import { useEffect, useState, type ReactNode } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { useEnvironmentThread } from "../../state/threads";
import {
  collectSessionRefs,
  descendantSubagentIds,
  joinableSessionRef,
  sessionListKey,
  type SpendThreadNode,
} from "./threadSpend";

/** Live thread streams are expensive. Descendants of the open thread stay under this cap. */
const MAX_LOADED_DESCENDANTS = 24;
/** Matches UsageService. A larger set is not priced, so a short total is never shown. */
const MAX_PRICED_SESSIONS = 200;

function sessionsFromState(
  requested: boolean,
  state: ReturnType<typeof useEnvironmentThread>,
): readonly UsageSessionRef[] | null {
  if (!requested) return null;
  const projection = Option.getOrNull(state.data);
  if (projection === null) {
    return state.status === "live" || state.status === "cached" || state.status === "deleted"
      ? []
      : null;
  }
  const refs: UsageSessionRef[] = [];
  for (const providerThread of projection.providerThreads) {
    const ref = joinableSessionRef(
      providerThread.driver,
      providerThread.nativeThreadRef?.nativeId ?? null,
      providerThread.nativeThreadRef?.strength ?? "none",
    );
    if (ref !== null) refs.push(ref);
  }
  return refs;
}

function JoinedSessionLoader(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onSessions: (threadId: string, sessions: readonly UsageSessionRef[] | null) => void;
}) {
  const state = useEnvironmentThread(props.environmentId, props.threadId);
  const sessions = sessionsFromState(true, state);
  const report = useStableCallback(props.onSessions);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports a child thread's sessions, which arrive on that thread's own live stream, to the parent's state on every stream update.
  useEffect(() => {
    report(props.threadId, sessions);
  }, [report, props.threadId, sessions]);
  return null;
}

function shellNode(
  shell: EnvironmentThreadShell,
  sessions: readonly UsageSessionRef[] | null,
): SpendThreadNode {
  return {
    id: shell.id,
    title: shell.title,
    environmentId: shell.environmentId,
    deleted: shell.deletedAt !== null,
    relationshipToParent: shell.lineage.relationshipToParent,
    parentThreadId: shell.lineage.parentThreadId,
    activeProviderThreadId: shell.activeProviderThreadId,
    sessions,
  };
}

/**
 * Sessions for the open thread, plus its subagent descendants.
 * Other project threads stay unloaded so each one does not open a live snapshot stream.
 */
export function useJoinedSpendSessions(input: {
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly shells: readonly EnvironmentThreadShell[];
  readonly focusThreadId: ThreadId | null;
}): {
  readonly nodes: readonly SpendThreadNode[];
  readonly sessionKey: string;
  readonly sessions: readonly UsageSessionRef[];
  readonly overCap: boolean;
  readonly loaders: ReactNode;
} {
  const focusState = useEnvironmentThread(
    input.enabled ? input.environmentId : null,
    input.enabled ? input.focusThreadId : null,
  );
  const focusSessions = sessionsFromState(
    input.enabled && input.focusThreadId !== null,
    focusState,
  );
  const descendantIds =
    !input.enabled || input.focusThreadId === null || input.environmentId === null
      ? []
      : descendantSubagentIds(
          input.focusThreadId,
          input.shells.map((shell) => shellNode(shell, null)),
        )
          .filter((id) =>
            input.shells.some(
              (shell) =>
                shell.id === id &&
                shell.environmentId === input.environmentId &&
                shell.deletedAt === null,
            ),
          )
          .sort()
          .slice(0, MAX_LOADED_DESCENDANTS);
  const [loaded, setLoaded] = useState<ReadonlyMap<string, readonly UsageSessionRef[] | null>>(
    () => new Map(),
  );
  const onSessions = useStableCallback(
    (threadId: string, sessions: readonly UsageSessionRef[] | null) => {
      setLoaded((current) => {
        if (
          sessionListKey(current.get(threadId)) === sessionListKey(sessions) &&
          current.has(threadId)
        ) {
          return current;
        }
        const next = new Map(current);
        next.set(threadId, sessions);
        return next;
      });
    },
  );
  const nodes = input.shells.map((shell) => {
    if (shell.id === input.focusThreadId) return shellNode(shell, focusSessions);
    if (descendantIds.includes(shell.id)) {
      return shellNode(shell, loaded.get(shell.id) ?? null);
    }
    return shellNode(shell, null);
  });
  const sessions = collectSessionRefs(
    nodes.filter(
      (node) =>
        !node.deleted &&
        (input.environmentId === null || node.environmentId === input.environmentId),
    ),
  );
  const overCap = sessions.length > MAX_PRICED_SESSIONS;
  const pricedSessions = overCap ? [] : sessions;
  const key = pricedSessions.map((ref) => `${ref.provider}:${ref.sessionId}`).join("\n");
  const loaders =
    input.enabled && input.environmentId !== null
      ? descendantIds.map((threadId) => (
          <JoinedSessionLoader
            key={threadId}
            environmentId={input.environmentId as EnvironmentId}
            threadId={threadId as ThreadId}
            onSessions={onSessions}
          />
        ))
      : null;
  return { nodes, sessionKey: key, sessions: pricedSessions, overCap, loaders };
}
