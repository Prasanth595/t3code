import type {
  GitRunStackedActionInput,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";
import { type ChangeRequestTerminology, sourceControlClients } from "../sourceControlClients.ts";

export type GitActionIconName = "commit" | "push" | "pr";

export type GitDialogAction = "commit" | "push" | "create_pr";

export interface GitActionMenuItem {
  id: "commit" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog" | "open_pr";
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_pr" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface DefaultBranchActionDialogCopy {
  title: string;
  description: string;
  continueLabel: string;
}

export type DefaultBranchConfirmableAction =
  | "push"
  | "create_pr"
  | "commit_push"
  | "commit_push_pr";

export type GitActionRequestInput = Pick<
  GitRunStackedActionInput,
  "action" | "commitMessage" | "featureBranch" | "filePaths"
>;

export function changeRequestTerminologyFor(
  gitStatus: VcsStatusResult | null,
): ChangeRequestTerminology {
  return sourceControlClients.get(gitStatus?.sourceControlProvider?.kind).changeRequest;
}

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasOriginRemote = true,
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const terminology = changeRequestTerminologyFor(gitStatus);

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const canPushWithoutUpstream = hasOriginRemote && !gitStatus.hasUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !hasChanges &&
    !isBehind &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !isBusy &&
    hasBranch &&
    !hasOpenPr &&
    (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0 &&
    !isBehind &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canOpenPr = !isBusy && hasOpenPr;

  return [
    {
      id: "commit",
      label: "Commit",
      disabled: !canCommit,
      icon: "commit",
      kind: "open_dialog",
      dialogAction: "commit",
    },
    {
      id: "push",
      label: "Push",
      disabled: !canPush,
      icon: "push",
      kind: "open_dialog",
      dialogAction: "push",
    },
    hasOpenPr
      ? {
          id: "pr",
          label: `Vezi ${terminology.shortLabel}`,
          disabled: !canOpenPr,
          icon: "pr",
          kind: "open_pr",
        }
      : {
          id: "pr",
          label: `Create ${terminology.shortLabel}`,
          disabled: !canCreatePr,
          icon: "pr",
          kind: "open_dialog",
          dialogAction: "create_pr",
        },
  ];
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultBranch = false,
  hasOriginRemote = true,
): GitQuickAction {
  if (isBusy) {
    return { label: "Commit", disabled: true, kind: "show_hint", hint: "Acțiune Git în curs." };
  }

  if (!gitStatus) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Starea Git nu e disponibilă.",
    };
  }

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isDiverged = isAhead && isBehind;
  const terminology = changeRequestTerminologyFor(gitStatus);

  if (!hasBranch) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: `Creează și comută pe un branch înainte de push sau de a deschide ${terminology.shortLabel}.`,
    };
  }

  if (hasChanges) {
    if (!gitStatus.hasUpstream && !hasOriginRemote) {
      return { label: "Commit", disabled: false, kind: "run_action", action: "commit" };
    }
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: "Commit și push",
        disabled: false,
        kind: "run_action",
        action: "commit_push",
      };
    }
    return {
      label: `Commit, push și ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasOriginRemote) {
      if (hasOpenPr && !isAhead) {
        return { label: `Vezi ${terminology.shortLabel}`, disabled: false, kind: "open_pr" };
      }
      return {
        label: "Push",
        disabled: true,
        kind: "show_hint",
        hint: `Adaugă un remote „origin” înainte de push sau de a crea ${terminology.shortLabel}.`,
      };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        return { label: `Vezi ${terminology.shortLabel}`, disabled: false, kind: "open_pr" };
      }
      return {
        label: "Push",
        disabled: true,
        kind: "show_hint",
        hint: "No local commits to push.",
      };
    }
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultBranch ? "commit_push" : "push",
      };
    }
    return {
      label: `Push și creează ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (isDiverged) {
    return {
      label: "Sincronizează branch-ul",
      disabled: true,
      kind: "show_hint",
      hint: "Branch-ul s-a despărțit de upstream. Fă mai întâi rebase/merge.",
    };
  }

  if (isBehind) {
    return {
      label: "Pull",
      disabled: false,
      kind: "run_pull",
    };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultBranch ? "commit_push" : "push",
      };
    }
    return {
      label: `Push și creează ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (hasOpenPr && gitStatus.hasUpstream) {
    return { label: `Vezi ${terminology.shortLabel}`, disabled: false, kind: "open_pr" };
  }

  return {
    label: "Commit",
    disabled: true,
    kind: "show_hint",
    hint: "Branch-ul e la zi. Nu e nevoie de nicio acțiune.",
  };
}

export function getGitActionDisabledReason(input: {
  item: GitActionMenuItem;
  gitStatus: VcsStatusResult | null;
  isBusy: boolean;
  hasOriginRemote: boolean;
}): string | null {
  const { item, gitStatus, isBusy, hasOriginRemote } = input;
  if (!item.disabled) return null;
  if (isBusy) return "Acțiune Git în curs.";
  if (!gitStatus) return "Starea Git nu e disponibilă.";

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const terminology = changeRequestTerminologyFor(gitStatus);

  if (item.id === "commit") {
    if (!hasChanges) {
      return "Worktree-ul e curat. Fă modificări înainte de commit.";
    }
    return "Commit-ul nu e disponibil momentan.";
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return "HEAD detașat: comută pe un branch înainte de push.";
    }
    if (hasChanges) {
      return "Fă commit sau stash la modificările locale înainte de push.";
    }
    if (isBehind) {
      return "Branch-ul e în urma upstream. Fă pull/rebase înainte de push.";
    }
    if (!gitStatus.hasUpstream && !hasOriginRemote) {
      return "Adaugă un remote „origin” înainte de push.";
    }
    if (!isAhead) {
      return "Niciun commit local pentru push.";
    }
    return "Push-ul nu e disponibil momentan.";
  }

  if (hasOpenPr) {
    return `Vizualizarea ${terminology.shortLabel} nu e disponibilă momentan.`;
  }
  if (!hasBranch) {
    return `HEAD detașat: comută pe un branch înainte de a crea ${terminology.shortLabel}.`;
  }
  if (!gitStatus.hasUpstream && !hasOriginRemote) {
    return `Adaugă un remote „origin” înainte de a crea ${terminology.shortLabel}.`;
  }
  if ((gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) <= 0) {
    return `Niciun commit local de inclus în ${terminology.shortLabel}.`;
  }
  if (isBehind) {
    return `Branch-ul e în urma upstream. Fă pull/rebase înainte de a crea ${terminology.shortLabel}.`;
  }
  return `Crearea ${terminology.shortLabel} nu e disponibilă momentan.`;
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultBranch: boolean,
): boolean {
  if (!isDefaultBranch) return false;
  return (
    action === "push" ||
    action === "create_pr" ||
    action === "commit_push" ||
    action === "commit_push_pr"
  );
}

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  terminology: ChangeRequestTerminology;
}): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const { shortLabel } = input.terminology;
  const suffix = ` pe „${branchLabel}”. Poți continua pe acest branch sau poți crea un branch nou și rula aceeași acțiune acolo.`;

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: "Commit și push pe branch-ul implicit?",
        description: `Această acțiune va face commit și push la modificări${suffix}`,
        continueLabel: `Commit și push pe ${branchLabel}`,
      };
    }
    return {
      title: "Push pe branch-ul implicit?",
      description: `Această acțiune va face push la commit-urile locale${suffix}`,
      continueLabel: `Push pe ${branchLabel}`,
    };
  }

  if (input.includesCommit) {
    return {
      title: `Commit, push & create ${shortLabel} from default branch?`,
      description: `Această acțiune va face commit, push și va crea ${shortLabel}${suffix}`,
      continueLabel: `Commit, push și creează ${shortLabel}`,
    };
  }
  return {
    title: `Push & create ${shortLabel} from default branch?`,
    description: `Această acțiune va face push la commit-urile locale și va crea ${shortLabel}${suffix}`,
    continueLabel: `Push și creează ${shortLabel}`,
  };
}
