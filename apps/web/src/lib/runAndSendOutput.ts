import { sha256 } from "@noble/hashes/sha2";
import type { EnvironmentId, TerminalRunAndSendInput } from "@t3tools/contracts";

import { randomUUID } from "./utils";

type Request = {
  environmentId: EnvironmentId;
  input: TerminalRunAndSendInput;
};

export type RunAndSendOutputAction = { newExecution?: boolean; retrySendingOutput?: boolean };

/** Keep retry identity until an accepted request is deliberately run again. */
export function createRunAndSendOutputRequests(maxRequests = 256) {
  const sessionId = randomUUID();
  // Retain compact execution identities when accepted payloads leave the bounded cache.
  const executions = new Map<
    string,
    Pick<TerminalRunAndSendInput, "cwd" | "worktreePath"> & { generation: number }
  >();
  const requests = new Map<
    string,
    { request: Request; pending?: Promise<boolean>; accepted: boolean }
  >();
  return (
    environmentId: EnvironmentId,
    sourceId: string,
    input: Omit<TerminalRunAndSendInput, "terminalId">,
    start: (request: Request) => Promise<boolean>,
    action?: RunAndSendOutputAction,
  ): Promise<boolean> => {
    const key = JSON.stringify([environmentId, input.threadId, sourceId, input.command]);
    let entry = requests.get(key);
    if (entry?.pending) return entry.pending;
    if (action?.newExecution && (entry?.accepted || (!entry && executions.has(key)))) {
      executions.set(key, {
        generation: (executions.get(key)?.generation ?? 0) + 1,
        cwd: input.cwd,
        worktreePath: input.worktreePath,
      });
      requests.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (requests.size >= maxRequests) {
        const settledKey = [...requests].find(([, value]) => value.accepted && !value.pending)?.[0];
        // An uncertain result must retain its original payload and retry identity.
        if (settledKey === undefined) return Promise.resolve(false);
        requests.delete(settledKey);
      }
      const execution = executions.get(key) ?? {
        generation: 0,
        cwd: input.cwd,
        worktreePath: input.worktreePath,
      };
      executions.set(key, execution);
      // The server binds workspace metadata to the identity, including after cache eviction.
      const digest = sha256(
        new TextEncoder().encode(JSON.stringify([sessionId, key, execution.generation])),
      );
      const terminalId = `run-${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      entry = {
        request: {
          environmentId,
          input: { ...input, cwd: execution.cwd, worktreePath: execution.worktreePath, terminalId },
        },
        accepted: false,
      };
      requests.set(key, entry);
    }
    if (entry.accepted && !action?.retrySendingOutput) return Promise.resolve(true);
    const current = entry;
    current.pending = Promise.resolve()
      .then(() => start(current.request))
      .then((accepted) => {
        // A failed dispatch retry does not undo the known shell acceptance.
        current.accepted ||= accepted;
        return accepted;
      })
      .finally(() => {
        delete current.pending;
      });
    return current.pending;
  };
}
