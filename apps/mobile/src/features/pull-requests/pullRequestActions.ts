import {
  sourceControlClients,
  type ChangeRequestTerminology,
} from "@t3tools/client-runtime/source-control-clients";
import type {
  PullRequestAction,
  PullRequestDetail,
  PullRequestMergeMethod,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { PullRequestGlyph } from "./pullRequestGlyphs";

type ActionDetail = Pick<
  PullRequestDetail,
  "state" | "isDraft" | "mergeability" | "autoMergeEnabled" | "workflowApprovalsRequired"
> & {
  readonly capabilities: Pick<
    PullRequestDetail["capabilities"],
    "actions" | "mergeMethods" | "updateMethods" | "deleteBranch"
  >;
  readonly viewerPermissions: Pick<
    PullRequestDetail["viewerPermissions"],
    "actions" | "updateMethods"
  >;
  readonly mergeCapabilities: PullRequestDetail["mergeCapabilities"];
};

export const MERGE_METHODS = {
  squash: { title: "Squash and merge", description: "Combine the commits into one commit." },
  merge: {
    title: "Creează un commit de merge",
    description: "Păstrează commit-urile și adaugă un commit de merge.",
  },
  rebase: { title: "Rebase și merge", description: "Adaugă commit-urile fără un commit de merge." },
} as const satisfies Record<PullRequestMergeMethod, { title: string; description: string }>;

export function pullRequestActionLabel(
  action: PullRequestAction,
  terminology: ChangeRequestTerminology,
): string {
  switch (action) {
    case "merge":
      return `Merge ${terminology.singular}`;
    case "ready":
      return "Marchează gata de revizuire";
    case "draft":
      return "Transformă în ciornă";
    case "close":
      return `Închide ${terminology.singular}`;
    case "reopen":
      return `Redeschide ${terminology.singular}`;
    case "update-branch":
      return "Actualizează branch-ul";
    case "enable-auto-merge":
      return "Activează auto-merge";
    case "disable-auto-merge":
      return "Dezactivează auto-merge";
    case "revert":
      return `Creează ${terminology.singular} de revert`;
    case "delete-branch":
      return "Șterge branch-ul";
    case "approve-workflows":
      return "Aprobă workflow-urile";
  }
}

export const PR_ACTION_ICONS = {
  merge: PullRequestGlyph.merged,
  ready: "checkmark.circle",
  draft: "pencil",
  close: "xmark",
  reopen: "arrow.clockwise",
  "update-branch": "arrow.up.circle",
  "enable-auto-merge": "clock",
  "disable-auto-merge": "xmark",
  revert: "arrow.uturn.backward",
  "delete-branch": "trash",
  "approve-workflows": "checkmark",
} as const satisfies Record<PullRequestAction, AppSymbolName>;

export const ALL_PR_ACTIONS: readonly PullRequestAction[] = [
  "merge",
  "ready",
  "draft",
  "update-branch",
  "enable-auto-merge",
  "disable-auto-merge",
  "approve-workflows",
  "close",
  "reopen",
  "revert",
  "delete-branch",
];

export function allowedMergeMethods(pr: ActionDetail) {
  return pr.capabilities.mergeMethods.filter((method) => pr.mergeCapabilities[method]);
}

export function allowedUpdateMethods(pr: ActionDetail) {
  return (pr.capabilities.updateMethods ?? []).filter((method) =>
    pr.viewerPermissions.updateMethods?.includes(method),
  );
}

export function canPerformPullRequestAction(pr: ActionDetail, action: PullRequestAction) {
  if (!pr.capabilities.actions.includes(action) || !pr.viewerPermissions.actions.includes(action))
    return false;
  if (action === "reopen") return pr.state === "closed";
  if (action === "revert") return pr.state === "merged";
  if (action === "delete-branch")
    return pr.state !== "open" && pr.capabilities.deleteBranch === true;
  if (pr.state !== "open") return false;
  switch (action) {
    case "update-branch":
      return allowedUpdateMethods(pr).length > 0;
    case "approve-workflows":
      return (pr.workflowApprovalsRequired ?? 0) > 0;
    case "ready":
      return pr.isDraft;
    case "draft":
      return !pr.isDraft;
    case "merge":
      return !pr.isDraft && pr.mergeability !== "conflicting" && allowedMergeMethods(pr).length > 0;
    case "enable-auto-merge":
      return !pr.isDraft && pr.autoMergeEnabled === false && allowedMergeMethods(pr).length > 0;
    case "disable-auto-merge":
      return pr.autoMergeEnabled === true;
    default:
      return true;
  }
}

export const MERGE_CONFLICT_REASON = "Rezolvă conflictele branch-ului înainte de merge.";

export function mergeUnavailableReason(
  pr: ActionDetail,
  connectionAllowsWrites: boolean,
  terminology: ChangeRequestTerminology,
) {
  if (pr.state === "merged") return `Acest ${terminology.singular} a fost deja îmbinat.`;
  if (pr.state === "closed") return `Redeschide acest ${terminology.singular} înainte de merge.`;
  if (!connectionAllowsWrites) return "Conexiunea la acest mediu e doar pentru citire.";
  if (!pr.capabilities.actions.includes("merge")) return "Acest furnizor nu suportă merge aici.";
  if (!pr.viewerPermissions.actions.includes("merge"))
    return `Contul tău nu poate face merge la acest ${terminology.singular}.`;
  if (pr.isDraft) return "Marchează ciorna ca gata de revizuire înainte de merge.";
  if (pr.mergeability === "conflicting") return MERGE_CONFLICT_REASON;
  if (!allowedMergeMethods(pr).length)
    return "Acest repository nu are metode de merge disponibile.";
  return null;
}

export function mergeSummary(
  pr: ActionDetail & Pick<PullRequestDetail, "autoMergeMethod">,
  connectionAllowsWrites: boolean,
  terminology: ChangeRequestTerminology,
) {
  if (pr.state === "merged") return "Îmbinat";
  if (pr.state === "closed") return "Închis";
  if (pr.isDraft) return "Ciornă";
  if (pr.mergeability === "conflicting") return "Are conflicte";
  if (!connectionAllowsWrites) return "Conexiune doar pentru citire";
  const allowed = allowedMergeMethods(pr);
  const method = pr.autoMergeMethod ?? (allowed.includes("squash") ? "squash" : allowed[0]);
  const methodLabel = method ? `${method[0]?.toUpperCase()}${method.slice(1)}` : "Merge";
  if (pr.autoMergeEnabled) return `${methodLabel} · auto-merge activ`;
  if (mergeUnavailableReason(pr, connectionAllowsWrites, terminology)) return "Indisponibil";
  return `${methodLabel}${pr.autoMergeEnabled === false ? " · auto-merge oprit" : ""}`;
}

export const openOnProviderLabel = (provider: SourceControlProviderKind) =>
  `Deschide pe ${sourceControlClients.get(provider).label}`;
