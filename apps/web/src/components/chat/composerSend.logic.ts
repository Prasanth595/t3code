import type { EnvironmentId, ThreadContextRecord } from "@t3tools/contracts";
import { collectInlineContextIds } from "../../lib/composerContextReferences";

/** Attached threads the prompt still links to; replacing linked text leaves stale records. */
export function referencedThreadContexts(draft: {
  readonly prompt: string;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
}): ReadonlyArray<ThreadContextRecord> {
  if (draft.threadContexts.length === 0) return [];
  const referenced = new Set(collectInlineContextIds(draft.prompt));
  return draft.threadContexts.filter((record) => referenced.has(record.contextId));
}

/** Why a send waits for the user to pick a machine when no machine was chosen automatically. */
export function loadBalancingSendWarning(input: {
  readonly pending: boolean;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly candidateEnvironmentIds: ReadonlyArray<EnvironmentId>;
}) {
  if (input.pending) {
    return {
      title: "Se verifică resursele calculatorului",
      description: "Verificarea resurselor încă rulează. Poți alege un calculator din editor.",
    };
  }
  const noMachineReadsEveryThread =
    input.threadContexts.length > 0 &&
    !input.candidateEnvironmentIds.some((environmentId) =>
      input.threadContexts.every((record) => record.environmentId === environmentId),
    );
  return {
    title: "Alege un calculator ca să continui",
    description: noMachineReadsEveryThread
      ? "Niciun calculator nu poate citi toate conversațiile atașate. Alege unul din editor sau elimină conversațiile."
      : "Niciun calculator eligibil nu are resurse disponibile. Alege unul din editor ca să forțezi.",
  };
}

/**
 * Why a multiple-model send cannot start: the server predates worktree bootstrap, or the
 * draft is not a new thread on a Git branch with at least one model.
 */
export function multipleModelSendBlock(input: {
  readonly selectionCount: number;
  readonly serverSupportsWorktreeBootstrap: boolean;
  readonly isLocalDraftThread: boolean;
  readonly isGitRepo: boolean;
  readonly branch: string | null;
}): "server-outdated" | "needs-new-git-thread" | null {
  if (!input.serverSupportsWorktreeBootstrap) return "server-outdated";
  if (
    !input.isLocalDraftThread ||
    !input.isGitRepo ||
    !input.branch ||
    input.selectionCount === 0
  ) {
    return "needs-new-git-thread";
  }
  return null;
}

/** Why a message sent over pending approvals did not go out, or null to stop quietly. */
export function approvalRedirectNotice(input: {
  readonly draftChanged: boolean;
  readonly declined: boolean;
  readonly approvalResponding: boolean;
  readonly approvalArrived: boolean;
}): string | null {
  if (input.draftChanged) {
    return input.declined
      ? "Aprobare refuzată. Mesajul tău s-a schimbat, așa că nu a fost trimis."
      : "Mesajul tău s-a schimbat, așa că nu a fost trimis.";
  }
  if (input.approvalResponding) {
    return "Se răspunde deja la o aprobare, așa că mesajul tău nu a fost trimis.";
  }
  if (input.declined && input.approvalArrived) {
    return "A sosit altă aprobare, așa că mesajul tău nu a fost trimis.";
  }
  return null;
}
