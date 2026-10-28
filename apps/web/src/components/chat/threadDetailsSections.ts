import { RIGHT_PANEL_SECTION_IDS, type RightPanelSectionId } from "@t3tools/contracts/settings";

const RIGHT_PANEL_SECTION_LABELS: Record<RightPanelSectionId, string> = {
  environment: "Environment",
  "open-in-editor": "Open in editor",
  "project-scripts": "Project scripts",
  branch: "Branch",
  "git-actions": "Git actions",
  changes: "Changes",
  servers: "Servers",
  automations: "Automations",
  lineage: "Lineage",
};

export const RIGHT_PANEL_SECTIONS = RIGHT_PANEL_SECTION_IDS.map((id) => ({
  id,
  label: RIGHT_PANEL_SECTION_LABELS[id],
}));

/** Which sections apply to this thread, before the user's hidden list. */
export function threadDetailsSectionAvailability(input: {
  readonly density: "full" | "compact" | "essential";
  readonly isDraft: boolean;
  readonly showOpenInPicker: boolean;
  readonly hasProjectScripts: boolean;
  readonly hasGitCwd: boolean;
  readonly isGitRepo: boolean;
  readonly hasActiveProject: boolean;
}): Record<RightPanelSectionId, boolean> {
  const threadSections = input.density === "full" && !input.isDraft;
  const gitActions = input.hasGitCwd && input.hasActiveProject;
  return {
    environment: input.density === "full",
    "open-in-editor": input.density !== "essential" && input.showOpenInPicker,
    "project-scripts": input.hasProjectScripts,
    branch: input.hasGitCwd && input.isGitRepo,
    "git-actions": gitActions,
    // GitActionsControl renders the Changes row only inside a repository.
    changes: gitActions && input.isGitRepo,
    servers: threadSections,
    automations: threadSections,
    lineage: threadSections,
  };
}

export function resolveThreadDetailsSections(
  hidden: ReadonlyArray<RightPanelSectionId>,
  available: Record<RightPanelSectionId, boolean>,
) {
  const shown = Object.fromEntries(
    RIGHT_PANEL_SECTION_IDS.map((id) => [id, available[id] && !hidden.includes(id)]),
  ) as Record<RightPanelSectionId, boolean>;
  return {
    shown,
    workspace: shown.environment || shown["open-in-editor"] || shown["project-scripts"],
    versionControl: shown.branch || shown["git-actions"] || shown.changes,
  };
}
