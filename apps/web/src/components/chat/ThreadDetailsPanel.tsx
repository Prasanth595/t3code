import type {
  EditorId,
  EnvironmentId,
  ProjectId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";

import type { DraftId } from "../../composerDraftStore";
import { useClientSettings } from "../../hooks/useSettings";
import { useT3ProjectFileScripts } from "../../hooks/useT3ProjectFileScripts";
import { type EnvMode, type EnvironmentOption } from "../BranchToolbar.logic";
import { BranchToolbar } from "../BranchToolbar";
import BaseGitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { memo, type ComponentProps } from "react";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { ThreadServersPanel } from "./ThreadServersPanel";
import { resolveThreadDetailsSections } from "./threadDetailsSections";

const GitActionsControl = memo(BaseGitActionsControl);

interface ThreadDetailsPanelProps extends Pick<
  ComponentProps<typeof ThreadDetailsCard>,
  "anchor" | "handle"
> {
  forceNewWorktree?: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
  worktreePath: string | null;
  isServerThread: boolean;
  draftId?: DraftId;
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  openInShortcutEnabled: boolean;
  gitCwd: string | null;
  isGitRepo: boolean;
  envLocked: boolean;
  availableEnvironments: readonly EnvironmentOption[];
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  onEnvModeChange: (mode: EnvMode) => void;
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest: () => void;
  onOpenChanges?: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  const fileScripts = useT3ProjectFileScripts(
    props.environmentId,
    props.activeProjectScripts ? props.gitCwd : null,
  );
  const hiddenSections = useClientSettings((settings) => settings.hiddenRightPanelSections);
  const activeThreadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const branchToolbarProps = {
    showGitControls: props.isGitRepo,
    environmentId: props.environmentId,
    threadId: props.threadId,
    projectId: props.projectId,
    worktreePath: props.worktreePath,
    isServerThread: props.isServerThread,
    ...(props.draftId ? { draftId: props.draftId } : {}),
    onEnvModeChange: props.onEnvModeChange,
    startFromOrigin: props.startFromOrigin,
    onStartFromOriginChange: props.onStartFromOriginChange,
    envMode: props.envMode,
    ...(props.activeThreadBranchOverride !== undefined
      ? { activeThreadBranchOverride: props.activeThreadBranchOverride }
      : {}),
    ...(props.onActiveThreadBranchOverrideChange
      ? { onActiveThreadBranchOverrideChange: props.onActiveThreadBranchOverrideChange }
      : {}),
    envLocked: props.envLocked,
    forceNewWorktree: props.forceNewWorktree ?? false,
    onComposerFocusRequest: props.onComposerFocusRequest,
    ...(props.onCheckoutPullRequestRequest
      ? { onCheckoutPullRequestRequest: props.onCheckoutPullRequestRequest }
      : {}),
  };

  return (
    <ThreadDetailsCard
      threadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
      anchor={props.anchor}
      handle={props.handle}
    >
      {(density) => {
        const threadSectionsAvailable = density === "full" && !props.draftId;
        const sections = resolveThreadDetailsSections(hiddenSections, {
          environment: density === "full",
          "open-in-editor": density !== "essential" && props.showOpenInPicker,
          "project-scripts": props.activeProjectScripts !== undefined,
          branch: props.gitCwd !== null && props.isGitRepo,
          "git-actions": props.gitCwd !== null && props.activeProjectName !== undefined,
          changes: props.gitCwd !== null && props.activeProjectName !== undefined,
          servers: threadSectionsAvailable,
          automations: threadSectionsAvailable,
          lineage: threadSectionsAvailable,
        });
        return (
          <>
            {sections.workspace ? (
              <ThreadDetailsSection
                headingId="thread-details-workspace-heading"
                title="Workspace"
                separated={false}
                showHeading={false}
              >
                <div className="flex flex-col">
                  {sections.shown.environment ? (
                    <BranchToolbar
                      layout="panel"
                      panelSection="workspace"
                      availableEnvironments={props.availableEnvironments}
                      {...(props.onEnvironmentChange
                        ? { onEnvironmentChange: props.onEnvironmentChange }
                        : {})}
                      autoEnvironmentLabel={props.autoEnvironmentLabel}
                      onAutoEnvironment={props.onAutoEnvironment}
                      {...branchToolbarProps}
                    />
                  ) : null}

                  {sections.shown["open-in-editor"] ? (
                    <OpenInPicker
                      keybindings={props.keybindings}
                      environmentId={props.environmentId}
                      availableEditors={props.availableEditors}
                      openInCwd={props.gitCwd}
                      enableShortcut={props.openInShortcutEnabled}
                      displayMode="panel"
                    />
                  ) : null}

                  {sections.shown["project-scripts"] && props.activeProjectScripts ? (
                    <ProjectScriptsControl
                      environmentId={props.environmentId}
                      displayMode="panel"
                      scripts={props.activeProjectScripts}
                      fileScripts={fileScripts}
                      preferredScriptId={props.preferredScriptId}
                      onRunScript={props.onRunProjectScript}
                      onAddScript={props.onAddProjectScript}
                      onUpdateScript={props.onUpdateProjectScript}
                      onDeleteScript={props.onDeleteProjectScript}
                    />
                  ) : null}
                </div>
              </ThreadDetailsSection>
            ) : null}

            {sections.versionControl && props.gitCwd ? (
              <ThreadDetailsSection
                headingId="thread-details-version-control-heading"
                title="Version Control"
                showHeading={false}
                separated={density === "full"}
              >
                <div className="flex flex-col">
                  {sections.shown.branch ? (
                    <BranchToolbar layout="panel" panelSection="branch" {...branchToolbarProps} />
                  ) : null}
                  {sections.shown["git-actions"] || sections.shown.changes ? (
                    <GitActionsControl
                      showActions={sections.shown["git-actions"]}
                      showChanges={sections.shown.changes}
                      compact={density !== "full"}
                      gitCwd={props.gitCwd}
                      activeThreadRef={activeThreadRef}
                      {...(props.draftId ? { draftId: props.draftId } : {})}
                      {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
                    />
                  ) : null}
                </div>
              </ThreadDetailsSection>
            ) : null}

            {sections.shown.servers ? (
              <ThreadServersPanel environmentId={props.environmentId} threadId={props.threadId} />
            ) : null}

            {sections.shown.automations ? (
              <ThreadAutomationsPanel
                environmentId={props.environmentId}
                threadId={props.threadId}
              />
            ) : null}

            {sections.shown.lineage ? (
              <ThreadRelationshipsPanel
                environmentId={props.environmentId}
                threadId={props.threadId}
              />
            ) : null}
          </>
        );
      }}
    </ThreadDetailsCard>
  );
}
