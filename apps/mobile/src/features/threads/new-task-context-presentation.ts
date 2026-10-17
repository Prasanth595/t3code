import { sanitizeNewRefName } from "@t3tools/shared/git";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { resolveSendEnvMode } from "@t3tools/shared/projectSettings";
import type { ComposerDraftWorkspaceSelection } from "../../state/use-composer-drafts";

import { GIT_VCS_TERMINOLOGY, type VcsTerminology } from "@t3tools/shared/vcs";

type WorkspaceMode = "local" | "worktree";

export function resolveNewTaskWorkspaceSelection(input: {
  readonly selection: ComposerDraftWorkspaceSelection | undefined;
  readonly fallback: ComposerDraftWorkspaceSelection;
  readonly isGitRepo: boolean;
}): ComposerDraftWorkspaceSelection {
  const selection = input.selection ?? input.fallback;
  const mode = resolveSendEnvMode({ requestedEnvMode: selection.mode, isGitRepo: input.isGitRepo });
  return input.isGitRepo ? selection : { mode, branch: null, worktreePath: null };
}

export function resolveNewTaskWorkspaceLabel(input: {
  readonly workspaceMode: WorkspaceMode;
  readonly worktreePath: string | null;
  readonly terminology?: VcsTerminology;
}): string {
  const terminology = input.terminology ?? GIT_VCS_TERMINOLOGY;
  if (input.workspaceMode === "worktree") {
    return `New ${terminology.workspaceNoun}`;
  }
  return input.worktreePath
    ? `Current ${terminology.workspaceNoun}`
    : `Current ${terminology.currentRefFallback}`;
}

export function resolveNewTaskBranchWorktreePath(input: {
  readonly workspaceMode: WorkspaceMode;
  readonly projectCwd: string;
  readonly branchWorktreePath: string | null | undefined;
}): string | null {
  if (
    input.workspaceMode === "worktree" ||
    !input.branchWorktreePath ||
    input.branchWorktreePath === input.projectCwd
  ) {
    return null;
  }
  return input.branchWorktreePath;
}

export function resolveNewTaskLocalWorkspaceSelection(input: {
  readonly branches: ReadonlyArray<{
    readonly name: string;
    readonly current: boolean;
    readonly worktreePath?: string | null;
  }>;
  readonly projectCwd: string;
}): {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly awaitsCurrentBranch: boolean;
} {
  const currentBranch = input.branches.find((branch) => branch.current) ?? null;
  if (!currentBranch) {
    return {
      branch: null,
      worktreePath: null,
      awaitsCurrentBranch: true,
    };
  }

  return {
    branch: currentBranch.name,
    worktreePath: resolveNewTaskBranchWorktreePath({
      workspaceMode: "local",
      projectCwd: input.projectCwd,
      branchWorktreePath: currentBranch.worktreePath,
    }),
    awaitsCurrentBranch: false,
  };
}

export function resolveNewTaskBranchLabel(input: {
  readonly branchName: string | null;
  readonly startFromOrigin: boolean;
  readonly workspaceMode: WorkspaceMode;
  readonly pullRequestReference?: string;
  readonly terminology?: VcsTerminology;
}): string {
  if (input.workspaceMode === "worktree" && input.pullRequestReference) {
    const parsed = sourceControlClients.parseChangeRequestUrl(input.pullRequestReference);
    if (parsed) return `From ${parsed.definition.changeRequest.shortLabel} #${parsed.link.number}`;
  }
  if (!input.branchName) {
    return `Choose ${(input.terminology ?? GIT_VCS_TERMINOLOGY).refNoun}`;
  }

  if (input.workspaceMode === "local") {
    return input.branchName;
  }

  // Only the server can determine a local branch's configured remote.
  return input.startFromOrigin ? `From ${input.branchName} (remote)` : `From ${input.branchName}`;
}

export function shouldCheckoutNewTaskBranch(input: {
  readonly branchIsCurrent: boolean;
  readonly branchWorktreePath: string | null | undefined;
  readonly workspaceMode: WorkspaceMode;
}): boolean {
  return input.workspaceMode === "local" && !input.branchIsCurrent && !input.branchWorktreePath;
}

export function filterNewTaskBranches<T extends { readonly name: string }>(
  branches: ReadonlyArray<T>,
  rawQuery: string,
): ReadonlyArray<T> {
  const query = sanitizeNewRefName(rawQuery).toLowerCase();
  return query.length === 0
    ? branches
    : branches.filter((branch) => branch.name.toLowerCase().includes(query));
}
